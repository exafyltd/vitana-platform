/**
 * VTID-05011 — each AP-XXXX automation schedule names the token of the gateway
 * it calls. Pointing the memory jobs at production used to need the
 * Lambda-wide GATEWAY_INTERNAL_TOKEN_SECRET_ID override, which also re-pointed
 * every staging-target job's token. Runs the real script in --dry-run (exits
 * before any AWS call).
 */
import * as path from 'path';
import { spawnSync } from 'child_process';

const SCRIPT = path.resolve(__dirname, '../../../scripts/aws/setup-eventbridge-cron-migration.sh');
const PROD = 'https://gateway.vitanaland.com';
const STAGING = 'https://preview-aws-gateway.vitanaland.com';

function run(env: Record<string, string>, args: string[]) {
  const e: Record<string, string | undefined> = { ...process.env, DEFAULT_TENANT_ID: '00000000-0000-0000-0000-000000000001', ...env };
  delete e.GATEWAY_INTERNAL_TOKEN_SECRET_ID;
  delete e.GATEWAY_INTERNAL_TOKEN_SECRET_ID_PROD;
  if (!('AUTOMATIONS_GATEWAY_URL' in env)) delete e.AUTOMATIONS_GATEWAY_URL;
  const r = spawnSync('bash', [SCRIPT, '--dry-run', ...args], { env: e as NodeJS.ProcessEnv, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function extraOf(out: string, job: string): Record<string, string> {
  const line = out.split('\n').find((l) => l.trim().startsWith(`${job} `));
  expect(line).toBeDefined();
  return JSON.parse((line as string).split('extra=')[1]);
}

describe('VTID-05011: automation jobs carry their own token_secret_id', () => {
  it('default (staging target): the memory job names the staging token', () => {
    const r = run({}, ['--only', 'autopilot-memory-daily-learning-episode']);
    expect(r.status).toBe(0);
    expect(extraOf(r.out, 'autopilot-memory-daily-learning-episode')).toEqual({
      auth: 'gateway_internal',
      gateway_url: STAGING,
      token_secret_id: 'vitana/gateway/staging/internal-token',
    });
  });

  it('production target: the memory job names the production token', () => {
    const r = run({ AUTOMATIONS_GATEWAY_URL: PROD }, ['--only', 'autopilot-memory-own-post-capture']);
    expect(r.status).toBe(0);
    expect(extraOf(r.out, 'autopilot-memory-own-post-capture')).toEqual({
      auth: 'gateway_internal',
      gateway_url: PROD,
      token_secret_id: 'vitana/gateway/prod/internal-token',
    });
  });

  it('production target does not change the staging-target jobs (test-contract scanners, handoff sweep)', () => {
    const r = run({ AUTOMATIONS_GATEWAY_URL: PROD }, ['--only', 'gateway-dev-memory-handoff-sweep']);
    expect(r.status).toBe(0);
    const extra = extraOf(r.out, 'gateway-dev-memory-handoff-sweep');
    expect(extra.gateway_url).toBe(STAGING);
    expect(extra.token_secret_id).toBeUndefined();
  });

  it('every AP-XXXX job line names a token (none falls back to the Lambda-wide one)', () => {
    const r = run({ AUTOMATIONS_GATEWAY_URL: PROD }, []);
    expect(r.status).toBe(0);
    const apLines = r.out.split('\n').filter((l) => /\/api\/v1\/automations\/cron\/AP-\d+/.test(l));
    expect(apLines.length).toBeGreaterThan(10);
    for (const l of apLines) {
      expect(JSON.parse(l.split('extra=')[1]).token_secret_id).toBe('vitana/gateway/prod/internal-token');
    }
  });

  it('refuses any other gateway URL', () => {
    const r = run({ AUTOMATIONS_GATEWAY_URL: 'https://example.com' }, ['--only', 'autopilot-memory-own-post-capture']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('AUTOMATIONS_GATEWAY_URL must be');
  });
});
