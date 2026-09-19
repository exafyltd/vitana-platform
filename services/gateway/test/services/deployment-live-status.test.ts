// VTID-04117 — unit tests for deployment-live-status.ts, the pure logic
// behind GET /operator/deployments/live-status and POST
// /operator/deployments/redeploy: drift detection, the per-target result
// shape, and the redeploy request validator. The route handlers themselves
// only wire AWS/Supabase calls to these functions, so no Express/AWS-SDK
// mocking is needed here.

import {
  LIVE_STATUS_TARGETS,
  computeCommitDrift,
  buildLiveStatusTargetResult,
  validateRedeployRequest,
  REDEPLOY_ALLOWED_SERVICE,
  COMMIT_SHA_RE,
} from '../../src/services/deployment-live-status';

describe('LIVE_STATUS_TARGETS (VTID-04117)', () => {
  it('covers exactly the four §1b gateway/community-app rows, service names matching software_versions verbatim', () => {
    const services = LIVE_STATUS_TARGETS.map(t => t.service);
    expect(services).toEqual([
      'gateway',
      'gateway-staging',
      'vitana-community-app-awsdr',
      'vitana-community-app-staging',
    ]);
  });

  it('tags exactly the gateway rows as kind:"gateway" and the community-app rows as kind:"frontend"', () => {
    const kindByService = new Map(LIVE_STATUS_TARGETS.map(t => [t.service, t.kind]));
    expect(kindByService.get('gateway')).toBe('gateway');
    expect(kindByService.get('gateway-staging')).toBe('gateway');
    expect(kindByService.get('vitana-community-app-awsdr')).toBe('frontend');
    expect(kindByService.get('vitana-community-app-staging')).toBe('frontend');
  });

  it('pairs each service with the correct environment and ECS service name', () => {
    const byService = new Map(LIVE_STATUS_TARGETS.map(t => [t.service, t]));
    expect(byService.get('gateway')).toMatchObject({ environment: 'production', ecsService: 'vitana-gateway-awsdr' });
    expect(byService.get('gateway-staging')).toMatchObject({ environment: 'staging', ecsService: 'vitana-gateway' });
    expect(byService.get('vitana-community-app-awsdr')).toMatchObject({ environment: 'production', ecsService: 'vitana-community-app-awsdr' });
    expect(byService.get('vitana-community-app-staging')).toMatchObject({ environment: 'staging', ecsService: 'vitana-community-app-staging' });
  });
});

describe('computeCommitDrift (VTID-04117)', () => {
  it('flags drift for a gateway target when the resolved (live) commit differs from the last logged success', () => {
    expect(computeCommitDrift('gateway', 'aaaaaaaaaaaa1111111111111111111111111111', 'bbbbbbbbbbbb2222222222222222222222222222')).toBe(true);
  });

  it('does not flag drift when the resolved and logged commits match on their first 12 chars', () => {
    expect(computeCommitDrift('gateway', 'aaaaaaaaaaaabbbbbbbbbbbb', 'aaaaaaaaaaaacccccccccccc')).toBe(false);
  });

  it('never flags drift for a frontend target, even with two different commit strings — no build-info endpoint exists to resolve one', () => {
    expect(computeCommitDrift('frontend', 'aaaaaaaaaaaa', 'bbbbbbbbbbbb')).toBe(false);
  });

  it('never flags drift when either side is null (unresolved build-info, or no logged success yet)', () => {
    expect(computeCommitDrift('gateway', null, 'bbbbbbbbbbbb')).toBe(false);
    expect(computeCommitDrift('gateway', 'aaaaaaaaaaaa', null)).toBe(false);
    expect(computeCommitDrift('gateway', null, null)).toBe(false);
  });
});

describe('buildLiveStatusTargetResult (VTID-04117)', () => {
  const gatewayTarget = LIVE_STATUS_TARGETS.find(t => t.service === 'gateway')!;
  const frontendTarget = LIVE_STATUS_TARGETS.find(t => t.service === 'vitana-community-app-awsdr')!;

  const ecs = {
    status: 'ACTIVE',
    desired_count: 2,
    running_count: 2,
    pending_count: 0,
    rollout_state: 'COMPLETED',
    task_definition: 'arn:aws:ecs:eu-central-1:472838866351:task-definition/vitana-gateway-awsdr:42',
  };

  it('surfaces a real drift on a gateway target whose live commit disagrees with the logged deploy', () => {
    const result = buildLiveStatusTargetResult(
      gatewayTarget,
      ecs,
      'aaaaaaaaaaaa1111',
      null,
      'bbbbbbbbbbbb2222',
      '2026-09-18T10:00:00Z',
    );
    expect(result.drift).toBe(true);
    expect(result.commit_verification).toBe('build-info');
    expect(result.resolved_commit).toBe('aaaaaaaaaaaa1111');
    expect(result.logged_commit).toBe('bbbbbbbbbbbb2222');
  });

  it('reports build-info resolution failures without crashing — resolve_error carries the reason, drift stays false', () => {
    const result = buildLiveStatusTargetResult(gatewayTarget, null, null, 'ECS DescribeServices timed out', null, null);
    expect(result.resolved_commit).toBeNull();
    expect(result.resolve_error).toBe('ECS DescribeServices timed out');
    expect(result.drift).toBe(false);
    expect(result.ecs).toBeNull();
  });

  it('never claims commit verification for a frontend target — it has no build-info endpoint to check against', () => {
    const result = buildLiveStatusTargetResult(frontendTarget, ecs, null, null, 'cccccccccccc3333', '2026-09-19T00:00:00Z');
    expect(result.commit_verification).toMatch(/not_available_here/);
    expect(result.drift).toBe(false);
    expect(result.ecs).toEqual(ecs);
  });
});

describe('validateRedeployRequest (VTID-04117)', () => {
  const VALID_SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

  it('accepts a valid redeploy request for the one supported service', () => {
    expect(validateRedeployRequest(REDEPLOY_ALLOWED_SERVICE, VALID_SHA, 'rolling back a broken sidebar redesign')).toEqual({ ok: true });
  });

  it('refuses gateway — there is no arbitrary-commit rebuild mode on AWS-PROD-DEPLOY-GATEWAY.yml', () => {
    const result = validateRedeployRequest('gateway', VALID_SHA, 'because');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid_service');
    expect(result.detail).toMatch(/AWS-PROD-DEPLOY-GATEWAY\.yml/);
  });

  it('refuses staging community-app too — that workflow has no commit_sha input', () => {
    const result = validateRedeployRequest('vitana-community-app-staging', VALID_SHA, 'because');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid_service');
  });

  it('refuses a malformed commit (too short, non-hex, or a full URL pasted in by mistake)', () => {
    expect(validateRedeployRequest(REDEPLOY_ALLOWED_SERVICE, 'abc123', 'because').error).toBe('invalid_commit');
    expect(validateRedeployRequest(REDEPLOY_ALLOWED_SERVICE, 'not-a-sha-zzzzzz', 'because').error).toBe('invalid_commit');
    expect(validateRedeployRequest(REDEPLOY_ALLOWED_SERVICE, 'https://github.com/x/y/commit/' + VALID_SHA, 'because').error).toBe('invalid_commit');
  });

  it('refuses an empty or whitespace-only reason', () => {
    expect(validateRedeployRequest(REDEPLOY_ALLOWED_SERVICE, VALID_SHA, '').error).toBe('missing_reason');
    expect(validateRedeployRequest(REDEPLOY_ALLOWED_SERVICE, VALID_SHA, '   ').error).toBe('missing_reason');
  });

  it('accepts a bare 7-char short SHA, not only a full 40-char one', () => {
    expect(validateRedeployRequest(REDEPLOY_ALLOWED_SERVICE, 'a1b2c3d', 'because').ok).toBe(true);
  });
});

describe('COMMIT_SHA_RE (VTID-04117)', () => {
  it('matches 7-40 char hex strings, case-insensitively', () => {
    expect(COMMIT_SHA_RE.test('a1b2c3d')).toBe(true);
    expect(COMMIT_SHA_RE.test('A1B2C3D')).toBe(true);
    expect(COMMIT_SHA_RE.test('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2')).toBe(true);
  });

  it('rejects anything shorter than 7 chars, longer than 40, or non-hex', () => {
    expect(COMMIT_SHA_RE.test('a1b2c3')).toBe(false);
    expect(COMMIT_SHA_RE.test('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2X')).toBe(false);
    expect(COMMIT_SHA_RE.test('not-hex!')).toBe(false);
  });
});
