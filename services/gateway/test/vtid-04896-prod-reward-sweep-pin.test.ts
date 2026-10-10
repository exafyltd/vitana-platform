/**
 * VTID-04896 pinned the VTNA reward sweep off in production until the owner
 * approved it (owner decision 2026-10-05). VTID-04944 (owner decision
 * 2026-10-07): it is pinned ON, so a publish without overrides keeps paying;
 * turning it off is a dispatch with env_overrides {"REWARD_SWEEP_ENABLED":"false"}.
 *
 * rewardSweepAllowed() (VTID-04878) pays unless VITANA_ENV=staging or
 * REWARD_SWEEP_ENABLED is exactly "false". The production deploy pins the
 * value, env_overrides (step 2/2) can still change it, and a read-only step
 * after the roll checks the live task definition (a mismatch fails the job,
 * which rolls back).
 *
 * The verify step now defaults to expecting "true", so it alone would not
 * notice a pin block dropped from the workflow when the previous task
 * definition already carried "true". These tests are that guard: the pin step
 * must exist, write "true" and run before 2/2.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { rewardSweepAllowed, rewardSweepLoopAllowed } from '../src/services/rewards/reward-sweep';

const WF = (name: string) => path.resolve(__dirname, '../../../.github/workflows', name);
const prodRaw = fs.readFileSync(WF('AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');
const stageRaw = fs.readFileSync(WF('AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
const steps = (yaml.load(prodRaw) as any).jobs['build-push-deploy'].steps as Array<{ name?: string; id?: string; run?: string; env?: Record<string, string> }>;
const at = (prefix: string) => steps.findIndex((s) => (s.name ?? '').startsWith(prefix));

describe('production deploy pins the reward sweep on (VTID-04944)', () => {
  const pin = steps[at('Build task-definition (reward payouts on)')];

  it('pins REWARD_SWEEP_ENABLED to "true" before the task definition is registered', () => {
    expect(pin).toBeDefined();
    expect(pin.run).toContain('{name:"REWARD_SWEEP_ENABLED", value:"true"}');
    expect(pin.run).not.toContain('{name:"REWARD_SWEEP_ENABLED", value:"false"}');
    expect(pin.run).toContain('select(.name != "REWARD_SWEEP_ENABLED")');
  });

  it('env_overrides (2/2) runs after the pin, so a "false" override wins', () => {
    const twoOfTwo = at('Build task-definition (2/2');
    expect(twoOfTwo).toBeGreaterThan(-1);
    expect(at('Build task-definition (reward payouts on)')).toBeLessThan(twoOfTwo);
    expect(steps[twoOfTwo].run).toContain('env_overrides');
  });

  it('"true" lets the sweep and its loop run on ECS; the "false" override still stops both', () => {
    const on = { REWARD_SWEEP_ENABLED: 'true', ECS_CONTAINER_METADATA_URI_V4: 'http://ecs' } as NodeJS.ProcessEnv;
    expect(rewardSweepAllowed(on)).toEqual({ ok: true });
    expect(rewardSweepLoopAllowed(on)).toBe(true);
    const off = { REWARD_SWEEP_ENABLED: 'false', ECS_CONTAINER_METADATA_URI_V4: 'http://ecs' } as NodeJS.ProcessEnv;
    expect(rewardSweepAllowed(off)).toEqual({ ok: false, error: 'DISABLED' });
    expect(rewardSweepLoopAllowed(off)).toBe(false);
  });

  it('checks the live task definition after the roll, before verification and rollback', () => {
    const i = at('Verify reward sweep setting');
    const check = steps[i];
    expect(check).toBeDefined();
    expect(i).toBeGreaterThan(at('Smoke'));
    expect(i).toBeLessThan(at('Roll back to the previous task definition'));
    expect(check.run).toContain('aws ecs describe-task-definition');
    expect(check.run).toContain('EXPECTED=true');
    expect(check.run).not.toContain('EXPECTED=false');
    expect(check.run).toMatch(/if \[ "\$LIVE" != "\$EXPECTED" \]; then[\s\S]*exit 1/);
    // Only an explicit env_overrides key changes the expectation.
    expect(check.env?.ENV_OVERRIDES_INPUT).toBe('${{ inputs.env_overrides }}');
    expect(check.run).toContain(`has("REWARD_SWEEP_ENABLED")`);
  });

  it('the check is read-only', () => {
    const run = steps[at('Verify reward sweep setting')].run ?? '';
    expect(run).not.toMatch(/update-service|register-task-definition|curl -X|POST/);
  });

  it('staging pins nothing: VITANA_ENV=staging already excludes it', () => {
    expect(stageRaw).not.toContain('REWARD_SWEEP_ENABLED');
    const { GATEWAY_WORKFLOW_PINS } = require('../src/services/conversation/conversation-flag-pins.generated');
    expect(GATEWAY_WORKFLOW_PINS.REWARD_SWEEP_ENABLED).toEqual({ staging: null, prod: 'true' });
  });
});
