/**
 * VTID-05159 (Health Hub Phase 1 / A2, plan Change 11) — the owner-run infra
 * scripts. Each runs here in its default dry-run mode with a fake `aws` on
 * PATH that records every call: a dry run must call nothing.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(__dirname, '../../../..');
const BUCKET = path.join(ROOT, 'scripts/aws/setup-health-raw-bucket.sh');
const ALARMS = path.join(ROOT, 'scripts/aws/setup-health-store-alarms.sh');
const CRON = path.join(ROOT, 'scripts/aws/setup-eventbridge-cron-migration.sh');

let bin: string;
let log: string;
beforeAll(() => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-aws-'));
  log = path.join(bin, 'calls.log');
  fs.writeFileSync(path.join(bin, 'aws'), `#!/usr/bin/env bash\necho "$@" >> "${log}"\nexit 0\n`, { mode: 0o755 });
});
afterAll(() => fs.rmSync(bin, { recursive: true, force: true }));
beforeEach(() => fs.rmSync(log, { force: true }));

function run(script: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [script, ...args], {
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME ?? '/tmp', ...env },
    encoding: 'utf8',
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, awsCalls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}

describe('setup-health-raw-bucket.sh (VTID-05159)', () => {
  it('dry run (default) prints the full plan and calls no AWS API', () => {
    const r = run(BUCKET, ['prod']);
    expect(r.status).toBe(0);
    expect(r.awsCalls).toBe('');
    expect(r.out).toContain('bucket   : vitana-health-raw-prod');
    expect(r.out).toContain('alias/vitana-health-raw-prod');
    expect(r.out).toContain('BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true');
    expect(r.out).toContain('"Expiration": { "Days": 30 }');
    expect(r.out).toContain('"AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }');
    expect(r.out).toContain('"aws:SecureTransport": "false"');
    expect(r.out).toContain('"kms:GenerateDataKey", "kms:Decrypt"');
    expect(r.out).toContain('versioning: left OFF');
    expect(r.out).toContain('Dry run only');
  });

  it('refuses staging and an unknown environment', () => {
    expect(run(BUCKET, ['staging']).status).toBe(1);
    expect(run(BUCKET, ['dev']).status).toBe(1);
    expect(run(BUCKET, []).status).toBe(1);
  });

  it('encrypts with SSE-KMS and a bucket key in the plan', () => {
    const src = fs.readFileSync(BUCKET, 'utf8');
    expect(src).toContain('"SSEAlgorithm":"aws:kms"');
    expect(src).toContain('"BucketKeyEnabled":true');
    expect(src).toContain('ACCOUNT_ID="472838866351"');
    expect(src).toContain('REGION="eu-central-1"');
  });
});

describe('setup-health-store-alarms.sh (VTID-05159)', () => {
  it('dry run calls nothing and plans the maintenance, partition and placement alarms', () => {
    const r = run(ALARMS, ['prod']);
    expect(r.status).toBe(0);
    expect(r.awsCalls).toBe('');
    for (const name of [
      'vitana-health-store-maintenance-stale-prod',
      'vitana-health-store-partition-missing-prod',
      'vitana-health-store-partition-writes-prod',
      'vitana-health-store-placement-5m-size-prod',
      'vitana-health-store-placement-upserts-prod',
      'vitana-health-store-placement-connected-prod',
    ]) {
      expect(r.out).toContain(name);
    }
    expect(r.out).toContain('--period 14400');
    expect(r.out).toContain('vitana-alarms-prod');
    expect(r.out).toContain('NOT ALARMED');
  });

  it('refuses staging; 0t needs an explicit log group', () => {
    expect(run(ALARMS, ['staging']).status).toBe(1);
    expect(run(ALARMS, ['0t']).status).toBe(1);
    expect(run(ALARMS, ['0t'], { LOG_GROUP: '/vitana/gateway-0t' }).status).toBe(0);
  });

  it('the metric filters match the log lines the gateway writes', () => {
    const src = fs.readFileSync(ALARMS, 'utf8');
    const maint = fs.readFileSync(path.join(ROOT, 'services/gateway/src/services/health-store/maintenance.ts'), 'utf8');
    const ingest = fs.readFileSync(path.join(ROOT, 'services/gateway/src/services/health-store/ingest.ts'), 'utf8');
    for (const ev of ['health_store_maintenance', 'health_store_partition_check', 'health_store_capacity']) {
      expect(src).toContain(`"${ev}"`);
      expect(maint).toContain(`event: '${ev}'`);
    }
    expect(ingest).toContain("event: 'health_store_ingest'");
    expect(ingest).toContain("'health.store.partition_missing'");
  });
});

describe('setup-eventbridge-cron-migration.sh: gateway-health-store-maintenance (VTID-05159)', () => {
  const base = { DEFAULT_TENANT_ID: '00000000-0000-0000-0000-000000000001' };

  it('is not created unless HEALTH_STORE_GATEWAY_URL names a store-enabled gateway', () => {
    const r = run(CRON, ['--dry-run'], base);
    expect(r.status).toBe(0);
    expect(r.out).not.toContain('gateway-health-store-maintenance');
    expect(r.awsCalls).toBe('');
  });

  it('with the production gateway: hourly at :23 UTC, internal token, production secret', () => {
    const r = run(CRON, ['--dry-run', '--only', 'gateway-health-store'], { ...base, HEALTH_STORE_GATEWAY_URL: 'https://gateway.vitanaland.com' });
    expect(r.status).toBe(0);
    expect(r.out).toContain('gateway-health-store-maintenance  (23 * * * * UTC)  -> /api/v1/health/internal/maintenance');
    expect(r.out).toContain('"auth":"gateway_internal"');
    expect(r.out).toContain('"token_secret_id":"vitana/gateway/prod/internal-token"');
  });

  it('refuses staging, and a non-production gateway without its token secret', () => {
    expect(run(CRON, ['--dry-run'], { ...base, HEALTH_STORE_GATEWAY_URL: 'https://preview-aws-gateway.vitanaland.com' }).status).toBe(1);
    expect(run(CRON, ['--dry-run'], { ...base, HEALTH_STORE_GATEWAY_URL: 'https://gateway-0t.example' }).status).toBe(1);
    const ok = run(CRON, ['--dry-run', '--only', 'gateway-health-store'], {
      ...base,
      HEALTH_STORE_GATEWAY_URL: 'https://gateway-0t.example',
      HEALTH_STORE_TOKEN_SECRET_ID: 'vitana/gateway/0t/internal-token',
    });
    expect(ok.status).toBe(0);
    expect(ok.out).toContain('"token_secret_id":"vitana/gateway/0t/internal-token"');
  });
});
