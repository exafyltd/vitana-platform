/**
 * VTID-04226 — the two test-contract scanner routes have an AWS scheduler.
 *
 * POST /api/v1/test-contracts/scheduled-run (failure scanner, VTID-02958) and
 * GET /api/v1/test-contracts/missing (missing-test scanner, VTID-02957) lost
 * their scheduler with GCP and were never added to
 * scripts/aws/setup-eventbridge-cron-migration.sh (VTID-03766) — their
 * source_types sit in the executor lane (autopilot-executable-source-types.ts)
 * with nothing ever producing a row. This pins the script's JOBS entries and
 * the Lambda's `auth: "gateway_internal"` support, the same way the VTID-03696
 * guard pins a workflow's `paths:` list: the shape that drifted silently now
 * has a test.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const SCRIPT = path.resolve(__dirname, '../../../scripts/aws/setup-eventbridge-cron-migration.sh');
const TOKEN_SCRIPT = path.resolve(__dirname, '../../../scripts/aws/setup-gateway-internal-token.sh');
const script = fs.readFileSync(SCRIPT, 'utf8');

function jobLines(): string[] {
  const start = script.indexOf('JOBS=(');
  const end = script.indexOf('\n)', start);
  return script
    .slice(start, end)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('"'));
}

describe('VTID-04226: EventBridge JOBS carry the two test-contract scanners', () => {
  const jobs = jobLines();

  it('lists gateway-test-contracts-scheduled-run every 15 minutes with the internal-token auth, targeting the test-contract gateway', () => {
    const j = jobs.find((l) => l.includes('gateway-test-contracts-scheduled-run'));
    expect(j).toBeDefined();
    expect(j).toContain('|*/15 * * * *|UTC|/api/v1/test-contracts/scheduled-run|{}|');
    expect(j).toContain('\\"auth\\":\\"gateway_internal\\"');
    expect(j).toContain('\\"gateway_url\\":\\"$TEST_CONTRACTS_GATEWAY_URL\\"');
  });

  it('lists gateway-test-contracts-missing daily as a GET with the internal-token auth', () => {
    const j = jobs.find((l) => l.includes('gateway-test-contracts-missing'));
    expect(j).toBeDefined();
    expect(j).toContain('|30 6 * * *|UTC|/api/v1/test-contracts/missing|{}|');
    expect(j).toContain('\\"method\\":\\"GET\\"');
    expect(j).toContain('\\"auth\\":\\"gateway_internal\\"');
  });

  it('the test-contract gateway defaults to STAGING (prod is an explicit override, IF-THEN 26)', () => {
    expect(script).toContain('TEST_CONTRACTS_GATEWAY_URL="${TEST_CONTRACTS_GATEWAY_URL:-https://preview-aws-gateway.vitanaland.com}"');
  });

  it('keeps every pre-existing VTID-03766 job (25) and adds exactly 2', () => {
    // +1: VTID-04391 AP-0914 daily learning episode.
    expect(jobs.length).toBe(28);
    expect(jobs.filter((l) => l.includes('/api/v1/automations/cron/AP-')).length).toBe(20);
  });

  it('the schedule Input merges the EXTRA json (method/auth/gateway_url) onto path+body', () => {
    expect(script).toContain("IFS='|' read -r NAME SCHEDULE TIMEZONE PATH_ BODY EXTRA <<< \"$JOB\"");
    expect(script).toContain("json.dumps(dict({'path': '$PATH_', 'body': json.loads('$BODY')}, **json.loads('$EXTRA')))");
  });
});

describe('VTID-04226: the shared Lambda can present X-Gateway-Internal without the token ever sitting in plain config', () => {
  const lambda = script.slice(script.indexOf("cat > \"$WORKDIR/index.js\" <<'JS'"), script.indexOf('\nJS\n'));

  it('reads the token from Secrets Manager at invoke time, cached, only for auth=gateway_internal jobs', () => {
    expect(lambda).toContain("require('@aws-sdk/client-secrets-manager')");
    expect(lambda).toContain('process.env.GATEWAY_INTERNAL_TOKEN_SECRET_ID');
    expect(lambda).toContain("if (event && event.auth === 'gateway_internal') headers['X-Gateway-Internal'] = await internalToken();");
    expect(lambda).not.toMatch(/process\.env\.GATEWAY_INTERNAL_TOKEN\b/);
  });

  it('honours method (GET sends no body) and a per-job gateway_url override', () => {
    expect(lambda).toContain("const method = (event && event.method ? String(event.method) : 'POST').toUpperCase();");
    expect(lambda).toContain("const base = (event && event.gateway_url) || process.env.GATEWAY_URL || 'https://gateway.vitanaland.com';");
    expect(lambda).toContain('if (body) req.write(body);');
  });

  it('still fails loudly on non-2xx (a 403 from a missing token is a Lambda error, not a silent success)', () => {
    expect(lambda).toMatch(/reject\(new Error\(`\$\{path\} returned \$\{res\.statusCode\}/);
  });

  it('grants the Lambda exec role GetSecretValue on exactly the internal-token secret and passes its id as env', () => {
    expect(script).toContain('"Action": "secretsmanager:GetSecretValue"');
    expect(script).toContain('secret:${INTERNAL_TOKEN_SECRET_ID}-*');
    expect(script).toContain('GATEWAY_INTERNAL_TOKEN_SECRET_ID=$INTERNAL_TOKEN_SECRET_ID');
  });
});

describe('VTID-04226: scripts parse and dry-run', () => {
  it('both scripts pass bash -n', () => {
    for (const f of [SCRIPT, TOKEN_SCRIPT]) {
      execFileSync('bash', ['-n', f], { stdio: ['pipe', 'pipe', 'pipe'] });
    }
  });

  it('--dry-run prints the two new jobs without calling AWS', () => {
    const out = execFileSync('bash', [SCRIPT, '--dry-run'], {
      env: { ...process.env, DEFAULT_TENANT_ID: '00000000-0000-0000-0000-000000000001', PATH: '/usr/bin:/bin' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
    expect(out).toContain('gateway-test-contracts-scheduled-run  (*/15 * * * * UTC)  -> /api/v1/test-contracts/scheduled-run');
    expect(out).toContain('gateway-test-contracts-missing  (30 6 * * * UTC)  -> /api/v1/test-contracts/missing');
    expect(out).toContain('Jobs:     28');
  });

  it('the token provisioning script is dry-run by default and never defaults to prod', () => {
    const out = execFileSync('bash', [TOKEN_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
    expect(out).toContain('DRY RUN');
    expect(out).toContain('vitana/gateway/staging/internal-token');
    expect(out).not.toContain('create-secret --region eu-central-1 --name vitana/gateway/prod');
  });
});
