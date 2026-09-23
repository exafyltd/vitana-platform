/**
 * VTID-04363: the Dev Autopilot loop runs on exactly one environment.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  resolveLoopOwnerEnv,
  isLoopOwner,
  describeLoopOwnership,
  LOOP_OWNER_ENV_VAR,
} from '../src/services/dev-autopilot-loop-owner';
import { buildAlerts } from '../src/services/dev-autopilot-supervisor';

const ROOT = path.resolve(__dirname, '../../..');

describe('resolveLoopOwnerEnv', () => {
  it('defaults to staging — the environment a merge to main deploys', () => {
    expect(resolveLoopOwnerEnv({})).toBe('staging');
    expect(resolveLoopOwnerEnv({ [LOOP_OWNER_ENV_VAR]: '' })).toBe('staging');
    expect(resolveLoopOwnerEnv({ [LOOP_OWNER_ENV_VAR]: 'prod' })).toBe('staging');
    expect(resolveLoopOwnerEnv({ [LOOP_OWNER_ENV_VAR]: 'PRODUCTION' })).toBe('staging');
  });
  it('moves to production only on the exact value', () => {
    expect(resolveLoopOwnerEnv({ [LOOP_OWNER_ENV_VAR]: 'production' })).toBe('production');
  });
});

describe('isLoopOwner / describeLoopOwnership', () => {
  it('staging owns by default, production stands down', () => {
    expect(isLoopOwner('staging', {})).toBe(true);
    expect(isLoopOwner('production', {})).toBe(false);
    expect(describeLoopOwnership('production', {})).toEqual({ owner_env: 'staging', this_env: 'production', active_here: false });
  });
  it('exactly one environment is active for every setting', () => {
    for (const v of [undefined, '', 'staging', 'production', 'typo']) {
      const env = { [LOOP_OWNER_ENV_VAR]: v };
      const active = (['staging', 'production'] as const).filter((e) => isLoopOwner(e, env));
      expect(active).toHaveLength(1);
    }
  });
});

describe('startBackgroundExecutor wiring', () => {
  const src = fs.readFileSync(path.join(ROOT, 'services/gateway/src/services/dev-autopilot-execute.ts'), 'utf8');
  it('returns before any setInterval when this gateway is not the owner', () => {
    const start = src.indexOf('export function startBackgroundExecutor');
    const body = src.slice(start, src.indexOf('export {', start));
    const gate = body.indexOf('if (!loop.active_here)');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(body.indexOf('setInterval('));
  });
});

describe('supervisor alert', () => {
  const base = {
    cfg: { kill_switch: false } as any,
    scan: { overdue: false, failed_7d: 0, stuck_runs: [] } as any,
    exec: { success_rate_7d: null, failed_7d: 0, top_failure_reasons: [], by_origin_7d: {}, awaiting_approval: 0 } as any,
    blockers: {},
    communityEngineLastRunAt: new Date().toISOString(),
    nowMs: Date.now(),
  };
  it('says so on the gateway that does not run the loop', () => {
    const a = buildAlerts({ ...base, loop: { owner_env: 'staging', this_env: 'production', active_here: false } });
    expect(a.some((x) => x.severity === 'info' && /does not run the autopilot loop/.test(x.text))).toBe(true);
  });
  it('stays quiet on the owner', () => {
    const a = buildAlerts({ ...base, loop: { owner_env: 'staging', this_env: 'staging', active_here: true } });
    expect(a.some((x) => /autopilot loop/.test(x.text))).toBe(false);
  });
});

describe('staging pins VITANA_ENV', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
  it('declares VITANA_ENV=staging and strips any earlier value', () => {
    expect(wf).toContain('{name:"VITANA_ENV", value:"staging"}');
    expect(wf).toMatch(/"NAV_CONTINUATION_BIND","VITANA_ENV",/);
  });
});
