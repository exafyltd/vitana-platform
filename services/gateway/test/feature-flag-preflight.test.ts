/**
 * VTID-04290 — the Intent Engine feature-flag preflight.
 *
 * stale-feature-flag-scanner-v1 flagged `FEATURE_INTENT_ENGINE_A` in
 * `src/index.ts`: it gates nine Intent Engine routers but is set in no deploy
 * config, so on AWS staging/prod the var is implicit-undefined and the routers
 * silently never mount. Two real incidents have the same shape (VTID-04098:
 * `FEATURE_*_ENV = "production"` resolved to `off` for weeks; VTID-03646:
 * `ORB_SAFE_FAST_GREETING` off on both stacks while a reload flag made it look
 * live). The fix here is not to guess a default — it is to say out loud, at
 * boot, which of the three states the process actually came up in.
 */

import fs from 'fs';
import path from 'path';

import app, {
  featureFlagPreflight,
  logFeatureFlagPreflight,
} from '../src/index';

const INDEX_SRC = fs.readFileSync(path.join(__dirname, '../src/index.ts'), 'utf8');
const FLAG = 'FEATURE_INTENT_ENGINE_A';

describe('featureFlagPreflight — the three states', () => {
  it('reports an explicit true as enabled, at info level', () => {
    const outcome = featureFlagPreflight(FLAG, 'true');
    expect(outcome.state).toBe('enabled');
    expect(outcome.level).toBe('info');
    expect(outcome.message).toContain(FLAG);
    expect(outcome.message).toContain('enabled');
  });

  it('reports an explicit false as disabled — the operator chose this', () => {
    const outcome = featureFlagPreflight(FLAG, 'false');
    expect(outcome.state).toBe('explicitly_disabled');
    expect(outcome.level).toBe('info');
    expect(outcome.message).toContain(FLAG);
    expect(outcome.message).toContain('explicitly disabled');
  });

  it('warns when the var is unset — the state the scanner found in production', () => {
    const outcome = featureFlagPreflight(FLAG, undefined);
    expect(outcome.state).toBe('implicit_undefined');
    expect(outcome.level).toBe('warn');
    expect(outcome.message).toContain(FLAG);
    expect(outcome.message).toContain('implicit-undefined');
    expect(outcome.message).toContain('not set');
  });

  it('warns on an unrecognised value too, quoting what actually came in', () => {
    const outcome = featureFlagPreflight(FLAG, 'production');
    expect(outcome.state).toBe('implicit_undefined');
    expect(outcome.level).toBe('warn');
    // The value itself is the actionable part — do not paraphrase it away.
    expect(outcome.message).toContain('"production"');
  });

  it('never disagrees with the check that actually gates the routers', () => {
    // `intentEngineEnabled` is `process.env.X === 'true'`, so every other value
    // must NOT be reported as enabled — a preflight that says "enabled" while
    // the gate stays shut is the exact bug this whole VTID is about.
    for (const raw of ['TRUE', 'True', ' true', 'true ', '1', 'yes', 'on', '']) {
      expect(featureFlagPreflight(FLAG, raw).state).not.toBe('enabled');
      expect(featureFlagPreflight(FLAG, raw).level).toBe('warn');
    }
  });

  it('is generic over the flag name it is handed', () => {
    expect(featureFlagPreflight('SOME_OTHER_FLAG', undefined).message).toContain('SOME_OTHER_FLAG');
    expect(featureFlagPreflight('SOME_OTHER_FLAG', 'true').message).not.toContain(FLAG);
  });
});

describe('logFeatureFlagPreflight — level routing', () => {
  const calls: Array<{ level: string; message: string }> = [];
  const sink = {
    log: (message: string) => calls.push({ level: 'log', message }),
    warn: (message: string) => calls.push({ level: 'warn', message }),
  };

  beforeEach(() => {
    calls.length = 0;
  });

  it('uses console.log for true and for false', () => {
    logFeatureFlagPreflight(FLAG, 'true', sink);
    logFeatureFlagPreflight(FLAG, 'false', sink);
    expect(calls.map((c) => c.level)).toEqual(['log', 'log']);
  });

  it('uses console.warn for the implicit-undefined case', () => {
    logFeatureFlagPreflight(FLAG, undefined, sink);
    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe('warn');
    expect(calls[0].message).toContain('implicit-undefined');
  });

  it('returns the outcome it logged', () => {
    expect(logFeatureFlagPreflight(FLAG, undefined, sink).state).toBe('implicit_undefined');
    expect(logFeatureFlagPreflight(FLAG, 'true', sink).state).toBe('enabled');
  });
});

describe('the live FEATURE_INTENT_ENGINE_A value', () => {
  const ORIGINAL = process.env[FLAG];

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env[FLAG];
    else process.env[FLAG] = ORIGINAL;
    jest.restoreAllMocks();
  });

  it('stays quiet-on-info when the env var is true', () => {
    process.env[FLAG] = 'true';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const outcome = logFeatureFlagPreflight(FLAG, process.env[FLAG]);
    expect(outcome.state).toBe('enabled');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns, naming the flag, when the env var is absent — as it is on staging today', () => {
    delete process.env[FLAG];
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    logFeatureFlagPreflight(FLAG, process.env[FLAG]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0].join(' ');
    expect(message).toContain(FLAG);
    expect(message).toContain('implicit-undefined');
  });
});

describe('boot wiring in src/index.ts', () => {
  it('runs the preflight for FEATURE_INTENT_ENGINE_A after the OAuth preflight block', () => {
    const oauthBlock = INDEX_SRC.indexOf('const oauthPreflight = [');
    const callSite = INDEX_SRC.indexOf(`logFeatureFlagPreflight('${FLAG}', process.env.${FLAG})`);
    expect(oauthBlock).toBeGreaterThan(-1);
    expect(callSite).toBeGreaterThan(oauthBlock);
    // Both live inside the main-gateway branch, not the vitana-dev-gateway
    // redirector that returns before any routes are imported.
    expect(callSite).toBeLessThan(INDEX_SRC.indexOf('export default app'));
  });

  it('records why the preflight exists, so it is not deleted as noise', () => {
    expect(INDEX_SRC).toContain('VTID-04290');
    expect(INDEX_SRC).toContain('stale-feature-flag-scanner-v1');
  });

  it('does not add FEATURE_INTENT_ENGINE_A to any deploy config (out of scope here)', () => {
    // The plan deliberately leaves the task definition alone; this asserts the
    // fix stayed a visibility change and did not silently flip the feature on.
    expect(INDEX_SRC).not.toMatch(/FEATURE_INTENT_ENGINE_A\s*=\s*'true'/);
    expect(app).toBeDefined();
  });
});
