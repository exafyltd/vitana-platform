/**
 * VTID-04646 — PUBLISH gate: only a passing STAGING-VERIFY run for the exact
 * staging commit lets a publish through without a written reason.
 */
import {
  decidePublishGate,
  evaluatePublishGate,
  isPublishGateEnabled,
  normalizeOverrideReason,
  toVerification,
  OVERRIDE_REASON_MIN,
  OVERRIDE_REASON_MAX,
} from '../../../src/services/testing/publish-gate';

const COMMIT = 'a'.repeat(40);

function row(topic: string, commit = COMMIT, extra: Record<string, unknown> = {}) {
  return {
    topic,
    created_at: '2026-09-26T10:00:00Z',
    metadata: { service: 'gateway', commit, run_url: 'https://github.com/x/runs/1', ...extra },
  };
}

describe('publish gate — pure pieces', () => {
  it('is on unless PUBLISH_REQUIRE_STAGING_VERIFY is exactly "false"', () => {
    expect(isPublishGateEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(isPublishGateEnabled({ PUBLISH_REQUIRE_STAGING_VERIFY: 'true' } as any)).toBe(true);
    expect(isPublishGateEnabled({ PUBLISH_REQUIRE_STAGING_VERIFY: 'FALSE' } as any)).toBe(true);
    expect(isPublishGateEnabled({ PUBLISH_REQUIRE_STAGING_VERIFY: 'false' } as any)).toBe(false);
  });

  it('accepts an override reason only at or above the minimum, and clips it', () => {
    expect(normalizeOverrideReason(undefined)).toBeNull();
    expect(normalizeOverrideReason(42)).toBeNull();
    expect(normalizeOverrideReason('  short  ')).toBeNull();
    expect(normalizeOverrideReason('x'.repeat(OVERRIDE_REASON_MIN))).toHaveLength(OVERRIDE_REASON_MIN);
    expect(normalizeOverrideReason('hotfix   for\n\nthe outage now')).toBe('hotfix for the outage now');
    expect(normalizeOverrideReason('y'.repeat(OVERRIDE_REASON_MAX + 50))).toHaveLength(OVERRIDE_REASON_MAX);
  });

  it('maps an OASIS row, including failed test names', () => {
    const v = toVerification(row('staging.verify.failed', COMMIT, {
      results: [{ suite: 'smoke', name: 'alive', ok: true }, { suite: 'VTID-1', name: 'route 401', ok: false }],
    }));
    expect(v).toMatchObject({ service: 'gateway', commit: COMMIT, outcome: 'failed', run_url: 'https://github.com/x/runs/1' });
    expect(v.failed_tests).toEqual([{ suite: 'VTID-1', name: 'route 401' }]);
    expect(toVerification({ topic: 'staging.verify.weird' }).outcome).toBe('unknown');
  });

  it('verifies only a passed run for the same commit', () => {
    const passed = toVerification(row('staging.verify.passed'));
    expect(decidePublishGate({ enabled: true, commit: COMMIT, verification: passed }))
      .toMatchObject({ allowed: true, status: 'verified', override_reason: null });
    const otherCommit = toVerification(row('staging.verify.passed', 'b'.repeat(40)));
    expect(decidePublishGate({ enabled: true, commit: COMMIT, verification: otherCommit }).allowed).toBe(false);
  });

  it.each([
    ['failed', /failed on aaaaaaa/],
    ['superseded', /superseded/],
    ['weird', /unrecognised/],
  ])('blocks a %s run without a reason', (outcome, msg) => {
    const v = toVerification(row(`staging.verify.${outcome}`));
    const d = decidePublishGate({ enabled: true, commit: COMMIT, verification: v });
    expect(d).toMatchObject({ allowed: false, status: 'blocked' });
    expect(d.reason).toMatch(msg);
  });

  it('blocks when no run exists and when the lookup failed', () => {
    expect(decidePublishGate({ enabled: true, commit: COMMIT, verification: null }).reason).toMatch(/No STAGING-VERIFY run/);
    expect(decidePublishGate({ enabled: true, commit: COMMIT, verification: null, lookupError: 'boom' }).reason).toMatch(/boom/);
  });

  it('lets a blocked publish through with a written reason, keeping why it was blocked', () => {
    const v = toVerification(row('staging.verify.failed'));
    const d = decidePublishGate({ enabled: true, commit: COMMIT, verification: v, overrideReason: 'Owner hotfix, test is flaky upstream' });
    expect(d).toMatchObject({ allowed: true, status: 'overridden', override_reason: 'Owner hotfix, test is flaky upstream' });
    expect(d.reason).toMatch(/failed/);
  });

  it('ignores a too-short reason', () => {
    const d = decidePublishGate({ enabled: true, commit: COMMIT, verification: null, overrideReason: 'ok' });
    expect(d.status).toBe('blocked');
  });

  it('reports disabled when the kill switch is off', () => {
    expect(decidePublishGate({ enabled: false, commit: COMMIT, verification: null }))
      .toMatchObject({ allowed: true, status: 'disabled' });
  });
});

describe('publish gate — evaluatePublishGate', () => {
  it('uses the newest row for the service and commit', async () => {
    const fetchRows = jest.fn().mockResolvedValue([row('staging.verify.passed'), row('staging.verify.failed')]);
    const d = await evaluatePublishGate({ commit: COMMIT, deps: { fetchRows }, env: {} as NodeJS.ProcessEnv });
    expect(fetchRows).toHaveBeenCalledWith('gateway', COMMIT);
    expect(d.status).toBe('verified');
  });

  it('fails closed on a lookup error and when Supabase is not configured', async () => {
    const fetchRows = jest.fn().mockRejectedValue(new Error('pgrst down'));
    const failed = await evaluatePublishGate({ commit: COMMIT, deps: { fetchRows }, env: {} as NodeJS.ProcessEnv });
    expect(failed).toMatchObject({ allowed: false, status: 'blocked' });
    expect(failed.reason).toMatch(/pgrst down/);
    const noDb = await evaluatePublishGate({ commit: COMMIT, deps: null, env: {} as NodeJS.ProcessEnv });
    expect(noDb.reason).toMatch(/Supabase not configured/);
  });

  it('skips the lookup entirely when disabled', async () => {
    const fetchRows = jest.fn();
    const d = await evaluatePublishGate({
      commit: COMMIT,
      deps: { fetchRows },
      env: { PUBLISH_REQUIRE_STAGING_VERIFY: 'false' } as any,
    });
    expect(d.status).toBe('disabled');
    expect(fetchRows).not.toHaveBeenCalled();
  });

  it('passes the service through', async () => {
    const fetchRows = jest.fn().mockResolvedValue([]);
    await evaluatePublishGate({ commit: COMMIT, service: 'community-app', deps: { fetchRows }, env: {} as NodeJS.ProcessEnv });
    expect(fetchRows).toHaveBeenCalledWith('community-app', COMMIT);
  });
});
