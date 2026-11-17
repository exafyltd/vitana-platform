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
