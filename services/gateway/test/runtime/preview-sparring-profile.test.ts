/**
 * Preview-sparring runtime profile.
 *
 * The isolated staging preview runs the gateway HTTP API for plan sparring and nothing else.
 * These tests pin the one switch that does that: the profile resolver (fail closed), and the
 * placement of the guard in the startup path (every worker start must come after it).
 */
import fs from 'fs';
import path from 'path';
import {
  resolveRuntimeProfile,
  backgroundWorkersAllowed,
  RUNTIME_PROFILES,
} from '../../src/runtime/runtime-profile';

describe('resolveRuntimeProfile', () => {
  it('defaults to full when unset or empty', () => {
    expect(resolveRuntimeProfile({})).toBe('full');
    expect(resolveRuntimeProfile({ GATEWAY_RUNTIME_PROFILE: '' })).toBe('full');
    expect(resolveRuntimeProfile({ GATEWAY_RUNTIME_PROFILE: '   ' })).toBe('full');
  });
  it('accepts the two known profiles', () => {
    expect(resolveRuntimeProfile({ GATEWAY_RUNTIME_PROFILE: 'full' })).toBe('full');
    expect(resolveRuntimeProfile({ GATEWAY_RUNTIME_PROFILE: 'preview-sparring' })).toBe('preview-sparring');
    expect(resolveRuntimeProfile({ GATEWAY_RUNTIME_PROFILE: ' preview-sparring ' })).toBe('preview-sparring');
  });
  it('refuses to start on an unknown value (a typo must not run the full worker set)', () => {
    for (const bad of ['preview', 'Preview-Sparring', 'sparring', 'off', 'false', '1']) {
      expect(() => resolveRuntimeProfile({ GATEWAY_RUNTIME_PROFILE: bad })).toThrow(/not a known profile/);
    }
  });
  it('lists exactly the two profiles', () => {
    expect([...RUNTIME_PROFILES]).toEqual(['full', 'preview-sparring']);
  });
});

describe('backgroundWorkersAllowed', () => {
  it('allows background work only in the full profile', () => {
    expect(backgroundWorkersAllowed('full')).toBe(true);
    expect(backgroundWorkersAllowed('preview-sparring')).toBe(false);
  });
});

describe('startup path: no worker starts before the profile guard', () => {
  const INDEX = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.ts'), 'utf8');
  const CALLBACK = 'const server = app.listen(PORT, async () => {';
  const GUARD = 'if (!backgroundWorkersAllowed(runtimeProfile)) {';
  // Anything that starts background work: a named start function, a timer, or a loop initialiser.
  const WORKER_START = /\b(start[A-Z]\w*|initialize[A-Z]\w*Controller|setInterval)\s*\(/g;

  it('the guard exists inside the listen callback and reads the resolved profile', () => {
    expect(INDEX).toContain(CALLBACK);
    expect(INDEX).toContain(GUARD);
    expect(INDEX).toContain("import { resolveRuntimeProfile, backgroundWorkersAllowed } from './runtime/runtime-profile';");
  });

  it('every worker start in the callback comes after the guard', () => {
    const afterCallback = INDEX.slice(INDEX.indexOf(CALLBACK) + CALLBACK.length);
    const guardAt = afterCallback.indexOf(GUARD);
    expect(guardAt).toBeGreaterThan(-1);
    const before = afterCallback.slice(0, guardAt);
    // Only the startup log lines may precede the guard, never a worker start.
    expect(before.match(WORKER_START)).toBeNull();
  });

  it('the guard is an early return, not a conditional around a single worker', () => {
    const afterCallback = INDEX.slice(INDEX.indexOf(CALLBACK) + CALLBACK.length);
    const guardAt = afterCallback.indexOf(GUARD);
    const block = afterCallback.slice(guardAt, guardAt + 260);
    expect(block).toMatch(/return;\s*\n\s*}/);
  });

  it('a worker start moved above the guard is detected (mutation check)', () => {
    const mutated = INDEX.replace(
      CALLBACK,
      CALLBACK + "\n      setInterval(() => {}, 1000);",
    );
    const afterCallback = mutated.slice(mutated.indexOf(CALLBACK) + CALLBACK.length);
    const before = afterCallback.slice(0, afterCallback.indexOf(GUARD));
    expect(before.match(WORKER_START)).not.toBeNull();
  });
});

describe('module-level timers go through the profile', () => {
  const SRC = path.join(__dirname, '..', '..', 'src');
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : e.name.endsWith('.ts') ? [p] : [];
    });

  it('no column-0 setInterval exists outside the profile module (import-time timers would bypass the profile)', () => {
    const offenders = walk(SRC)
      .filter((f) => !f.endsWith(path.join('runtime', 'runtime-profile.ts')))
      .filter((f) => /^(setInterval\(|const\s+\w+\s*=\s*setInterval\()/m.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it('scheduleBackground starts nothing in preview and a real timer in full', () => {
    jest.useFakeTimers();
    const spy = jest.spyOn(global, 'setInterval');
    try {
      const { scheduleBackground } = require('../../src/runtime/runtime-profile');
      const fn = jest.fn();
      expect(scheduleBackground(fn, 1000, { GATEWAY_RUNTIME_PROFILE: 'preview-sparring' })).toBeNull();
      expect(spy).not.toHaveBeenCalled();
      expect(scheduleBackground(fn, 1000, {})).not.toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(() => scheduleBackground(fn, 1000, { GATEWAY_RUNTIME_PROFILE: 'preivew' })).toThrow(/not a known profile/);
    } finally {
      spy.mockRestore();
      jest.useRealTimers();
    }
  });
});

describe('staging deploy workflow: preview cannot reach vitana-gateway', () => {
  const WF = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '..', '.github', 'workflows', 'AWS-STAGE-DEPLOY-GATEWAY.yml'),
    'utf8',
  );
  it('has an explicit runtime_profile input defaulting to full', () => {
    expect(WF).toMatch(/runtime_profile:\n\s+description:[^\n]*\n\s+required: false\n\s+default: 'full'/);
    expect(WF).toMatch(/options: \[full, preview-sparring\]/);
  });
  it('refuses preview-sparring on any service other than vitana-gateway-preview, and the reverse', () => {
    expect(WF).toContain('preview-sparring may only deploy to vitana-gateway-preview');
    expect(WF).toContain('vitana-gateway-preview only accepts runtime_profile=preview-sparring');
    expect(WF).toContain('preview-sparring must never touch the production-attached vitana-gateway');
  });
  it('the guard runs before the image build and the task-definition registration', () => {
    const guardAt = WF.indexOf('Preview guard');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(WF.indexOf('name: Build and push image'));
    expect(guardAt).toBeLessThan(WF.indexOf('name: Register task-definition revision + roll the service (1/2'));
  });
  it('the profile is stamped on every deploy and cleared from the previous revision first', () => {
    expect(WF).toContain('{name:"GATEWAY_RUNTIME_PROFILE", value:$ENV.RUNTIME_PROFILE}');
    expect(WF).toContain('"CLAUDE_AVAILABLE","GATEWAY_RUNTIME_PROFILE") | not)');
  });
});
