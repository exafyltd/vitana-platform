/**
 * VTID-04896 — the VTNA reward sweep stays off in production until the owner
 * explicitly approves it (owner decision 2026-10-05).
 *
 * rewardSweepAllowed() (VTID-04878) pays unless VITANA_ENV=staging or
 * REWARD_SWEEP_ENABLED is exactly "false". Production sets neither by itself,
 * so the production deploy pins it, and a read-only step after the roll checks
 * the live task definition (a mismatch fails the job, which rolls back).
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

describe('production deploy pins the reward sweep off', () => {
  const pin = steps[at('Build task-definition (reward sweep off)')];

  it('pins REWARD_SWEEP_ENABLED to "false" before the task definition is registered', () => {
    expect(pin).toBeDefined();
    expect(pin.run).toContain('{name:"REWARD_SWEEP_ENABLED", value:"false"}');
    expect(pin.run).toContain('select(.name != "REWARD_SWEEP_ENABLED")');
    expect(at('Build task-definition (reward sweep off)')).toBeLessThan(at('Build task-definition (2/2'));
  });

  it('that value really turns the sweep and its loop off', () => {
    const env = { REWARD_SWEEP_ENABLED: 'false', ECS_CONTAINER_METADATA_URI_V4: 'http://ecs' } as NodeJS.ProcessEnv;
    expect(rewardSweepAllowed(env)).toEqual({ ok: false, error: 'DISABLED' });
    expect(rewardSweepLoopAllowed(env)).toBe(false);
    // Without the pin a production ECS task would pay.
    expect(rewardSweepLoopAllowed({ ECS_CONTAINER_METADATA_URI_V4: 'http://ecs' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('checks the live task definition after the roll, before verification and rollback', () => {
    const i = at('Verify reward sweep setting');
    const check = steps[i];
    expect(check).toBeDefined();
    expect(i).toBeGreaterThan(at('Smoke'));
    expect(i).toBeLessThan(at('Roll back to the previous task definition'));
    expect(check.run).toContain('aws ecs describe-task-definition');
    expect(check.run).toContain('EXPECTED=false');
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
    expect(GATEWAY_WORKFLOW_PINS.REWARD_SWEEP_ENABLED).toEqual({ staging: null, prod: 'false' });
  });
});
