// VTID-04324 / VTID-04327 — pins the ECS scale-down allowlist that
// AWS-OPS-ECS-SCALE-UNGOVERNED.yml validates against before any AWS call.
// The workflow scales production ECS services, so what it can refuse matters
// more than what it can do: every service that serves traffic must be refused.

import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require('../../../scripts/ci/ecs-scale-allowlist.cjs');

const REPO = path.join(__dirname, '..', '..', '..');
const WORKFLOW = fs.readFileSync(
  path.join(REPO, '.github', 'workflows', 'AWS-OPS-ECS-SCALE-UNGOVERNED.yml'),
  'utf8',
);

describe('ECS scale allowlist', () => {
  test('holds exactly the 23 July-9 orphans plus the retired worker-runner', () => {
    expect(mod.UNGOVERNED_JULY9).toHaveLength(23);
    expect(mod.RETIRED).toEqual(['vitana-worker-runner']);
    expect(mod.ALLOWLIST).toHaveLength(24);
    expect(new Set(mod.ALLOWLIST).size).toBe(24);
  });

  test.each([
    'vitana-gateway',
    'vitana-gateway-awsdr',
    'vitana-community-app-awsdr',
    'vitana-community-app-staging',
    'vitana-oasis-operator-awsdr',
    'vitana-oasis-projector',
    'vitana-orb-agent',
    'vitana-erp-bridge',
    'vitana-postgrest-aurora-proxy',
    'vitana-vitana-verification-engine',
  ])('refuses the governed/serving service %s', (svc) => {
    expect(mod.ALLOWLIST).not.toContain(svc);
    const r = mod.resolveTargets(svc, '0');
    expect(r.ok).toBe(false);
    expect(r.error).toContain(svc);
  });

  test('one refused name refuses the whole request', () => {
    const r = mod.resolveTargets('vitana-auth-proxy,vitana-gateway-awsdr', '0');
    expect(r.ok).toBe(false);
  });

  test('"all" expands to the allowlist; explicit names are de-duplicated', () => {
    expect(mod.resolveTargets('all', '0').targets).toEqual([...mod.ALLOWLIST]);
    expect(mod.resolveTargets('vitana-auth-proxy, vitana-auth-proxy', '1').targets).toEqual(['vitana-auth-proxy']);
  });

  test('desired_count must be 0 or 1', () => {
    expect(mod.resolveTargets('all', '2').ok).toBe(false);
    expect(mod.resolveTargets('all', '').ok).toBe(false);
    expect(mod.resolveTargets('', '0').ok).toBe(false);
  });
});

describe('AWS-OPS-ECS-SCALE-UNGOVERNED.yml', () => {
  test('is dispatch-only, dry run by default, and requires a reason', () => {
    expect(WORKFLOW).toMatch(/on:\s*\n\s*workflow_dispatch:/);
    expect(WORKFLOW).not.toMatch(/^\s*(push|pull_request|schedule):/m);
    expect(WORKFLOW).toMatch(/dry_run:[\s\S]*?default: 'true'/);
    expect(WORKFLOW).toMatch(/reason:[\s\S]*?required: true/);
  });

  test('validates against the allowlist before assuming any AWS role', () => {
    const validate = WORKFLOW.indexOf('node scripts/ci/ecs-scale-allowlist.cjs');
    const creds = WORKFLOW.indexOf('configure-aws-credentials');
    expect(validate).toBeGreaterThan(0);
    expect(validate).toBeLessThan(creds);
  });

  test('uses OIDC and pins the account', () => {
    expect(WORKFLOW).toContain('secrets.AWS_PROD_ROLE_ARN');
    expect(WORKFLOW).toContain('472838866351');
    expect(WORKFLOW).not.toMatch(/AWS_SECRET_ACCESS_KEY/);
  });
});
