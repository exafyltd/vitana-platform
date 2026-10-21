// VTID-01961 (PR #4) — unit tests for the voice auto-rollback safety net
// (voice-auto-rollback.ts). Phase 7 (Voice/ORB tools) of
// docs/TEST_COVERAGE_PLAN.md — this is the module responsible for
// recommending a rollback after a self-healing voice fix fails its
// synthetic probe, directly relevant to the BOOTSTRAP-NOVA-SONIC-VOICE
// incident history.
//
// Scope:
//   1. Defensive no-op when the probe actually passed (ok:true) — must
//      never emit or recommend a rollback in that case.
//   2. The full OASIS event payload on a genuine probe failure, including
//      the rollback_command branch (prior_revision present vs. absent).
//   3. current_revision fallback to the module-level GATEWAY_REVISION
//      constant (K_REVISION -> BUILD_INFO -> 'unknown' priority), resolved
//      once at module load — verified via jest.resetModules() + re-require.
//   4. Fail-mode: emitOasisEvent() throwing/rejecting is caught and turned
//      into a graceful { emitted:false, recommendation:'manual_rollback' }
//      result rather than propagating — i.e. this safety net degrades
//      gracefully (always still recommends manual rollback) rather than
//      failing open (silently reporting nothing happened) or crashing the
//      caller.

const mockEmitOasisEvent = jest.fn();
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: any[]) => mockEmitOasisEvent(...args),
}));

import { triggerRollbackRecommendation } from '../../src/services/voice-auto-rollback';
import type { RollbackContext } from '../../src/services/voice-auto-rollback';
import type { ProbeResult } from '../../src/services/voice-synthetic-probe';

function makeFailedProbe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    ok: false,
    failure_mode_code: 'health_non_2xx',
    duration_ms: 1234,
    evidence: { health_status: 503 },
    ...overrides,
  };
}

function makeContext(overrides: Partial<RollbackContext> = {}): RollbackContext {
  return {
    vtid: 'VTID-01961',
    voice_class: 'greeting',
    normalized_signature: 'sig-abc',
    probe_result: makeFailedProbe(),
    ...overrides,
  };
}

beforeEach(() => {
  mockEmitOasisEvent.mockReset();
});

describe('triggerRollbackRecommendation() — probe passed (defensive no-op)', () => {
  test('does not emit and returns no_op when probe_result.ok is true', async () => {
    const ctx = makeContext({ probe_result: { ok: true, failure_mode_code: null, duration_ms: 50, evidence: {} } });

    const res = await triggerRollbackRecommendation(ctx);

    expect(res).toEqual({
      emitted: false,
      recommendation: 'no_op',
      detail: 'probe_passed_no_rollback_needed',
    });
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });
});

describe('triggerRollbackRecommendation() — probe failed', () => {
  test('emits voice.healing.rollback.triggered with the full expected payload', async () => {
    mockEmitOasisEvent.mockResolvedValue({ ok: true, event_id: 'evt-1' });
    const ctx = makeContext({
      spec_hash: 'hash-xyz',
      current_revision: 'gateway-00099',
      prior_revision: 'gateway-00098',
      session_id: 'sess-1',
    });

    const res = await triggerRollbackRecommendation(ctx);

    expect(mockEmitOasisEvent).toHaveBeenCalledTimes(1);
    const call = mockEmitOasisEvent.mock.calls[0][0];
    expect(call.type).toBe('voice.healing.rollback.triggered');
    expect(call.source).toBe('voice-auto-rollback');
    expect(call.status).toBe('error');
    expect(call.vtid).toBe('VTID-01961');
    expect(call.payload).toMatchObject({
      voice_class: 'greeting',
      normalized_signature: 'sig-abc',
      spec_hash: 'hash-xyz',
      failure_mode_code: 'health_non_2xx',
      probe_duration_ms: 1234,
      probe_evidence: { health_status: 503 },
      current_revision: 'gateway-00099',
      prior_revision: 'gateway-00098',
      session_id: 'sess-1',
      recommendation: 'manual_rollback',
    });

    expect(res).toEqual({
      emitted: true,
      recommendation: 'manual_rollback',
      detail: 'failure_mode=health_non_2xx',
    });
  });

  test('rollback_command interpolates prior_revision into the exact gcloud traffic-split command', async () => {
    mockEmitOasisEvent.mockResolvedValue({ ok: true });
    const ctx = makeContext({ prior_revision: 'gateway-00050' });

    await triggerRollbackRecommendation(ctx);

    const payload = mockEmitOasisEvent.mock.calls[0][0].payload;
    expect(payload.rollback_command).toBe(
      'gcloud run services update-traffic gateway --to-revisions=gateway-00050=100 --region=us-central1 --project=lovable-vitana-vers1',
    );
  });

  test('rollback_command falls back to a revisions-list command when prior_revision is absent', async () => {
    mockEmitOasisEvent.mockResolvedValue({ ok: true });
    const ctx = makeContext({ prior_revision: undefined });

    await triggerRollbackRecommendation(ctx);

    const payload = mockEmitOasisEvent.mock.calls[0][0].payload;
    expect(payload.rollback_command).toBe(
      'gcloud run revisions list --service=gateway --region=us-central1 --project=lovable-vitana-vers1 --limit=5',
    );
  });

  test('current_revision defaults to the module GATEWAY_REVISION when ctx.current_revision is omitted', async () => {
    mockEmitOasisEvent.mockResolvedValue({ ok: true });
    const ctx = makeContext({ current_revision: undefined });

    await triggerRollbackRecommendation(ctx);

    const payload = mockEmitOasisEvent.mock.calls[0][0].payload;
    // In this test process neither K_REVISION nor BUILD_INFO is set (see
    // setup-tests.ts), so the module-level constant resolves to 'unknown'.
    expect(payload.current_revision).toBe('unknown');
  });

  test('the human-readable message includes voice_class and failure_mode_code', async () => {
    mockEmitOasisEvent.mockResolvedValue({ ok: true });
    const ctx = makeContext({
      voice_class: 'farewell',
      probe_result: makeFailedProbe({ failure_mode_code: 'gemini_not_configured' }),
    });

    await triggerRollbackRecommendation(ctx);

    const call = mockEmitOasisEvent.mock.calls[0][0];
    expect(call.message).toContain('farewell');
    expect(call.message).toContain('gemini_not_configured');
    expect(call.message).toContain('Manual rollback recommended');
  });

  test.each([
    'probe_timeout',
    'health_unreachable',
    'health_non_2xx',
    'health_malformed_json',
    'gemini_not_configured',
    'tts_not_ready',
    'voice_disabled',
    'fallback_chat_tts_unavailable',
    'probe_error',
  ] as const)('every documented failure_mode_code (%s) is forwarded verbatim into the payload', async (code) => {
    mockEmitOasisEvent.mockResolvedValue({ ok: true });
    const ctx = makeContext({ probe_result: makeFailedProbe({ failure_mode_code: code }) });

    await triggerRollbackRecommendation(ctx);

    expect(mockEmitOasisEvent.mock.calls[0][0].payload.failure_mode_code).toBe(code);
  });
});

describe('GATEWAY_REVISION resolution (K_REVISION > BUILD_INFO > "unknown")', () => {
  const originalKRevision = process.env.K_REVISION;
  const originalBuildInfo = process.env.BUILD_INFO;

  afterEach(() => {
    if (originalKRevision === undefined) delete process.env.K_REVISION;
    else process.env.K_REVISION = originalKRevision;
    if (originalBuildInfo === undefined) delete process.env.BUILD_INFO;
    else process.env.BUILD_INFO = originalBuildInfo;
  });

  test('K_REVISION takes priority over BUILD_INFO when both are set', async () => {
    jest.resetModules();
    process.env.K_REVISION = 'gateway-from-k-revision';
    process.env.BUILD_INFO = 'gateway-from-build-info';

    const fresh = require('../../src/services/voice-auto-rollback');
    mockEmitOasisEvent.mockResolvedValue({ ok: true });

    await fresh.triggerRollbackRecommendation(makeContext({ current_revision: undefined }));

    const payload = mockEmitOasisEvent.mock.calls[0][0].payload;
    expect(payload.current_revision).toBe('gateway-from-k-revision');
  });

  test('BUILD_INFO is used when K_REVISION is unset', async () => {
    jest.resetModules();
    delete process.env.K_REVISION;
    process.env.BUILD_INFO = 'gateway-from-build-info-only';

    const fresh = require('../../src/services/voice-auto-rollback');
    mockEmitOasisEvent.mockResolvedValue({ ok: true });

    await fresh.triggerRollbackRecommendation(makeContext({ current_revision: undefined }));

    const payload = mockEmitOasisEvent.mock.calls[0][0].payload;
    expect(payload.current_revision).toBe('gateway-from-build-info-only');
  });

  test('falls back to "unknown" when neither env var is set', async () => {
    jest.resetModules();
    delete process.env.K_REVISION;
    delete process.env.BUILD_INFO;

    const fresh = require('../../src/services/voice-auto-rollback');
    mockEmitOasisEvent.mockResolvedValue({ ok: true });

    await fresh.triggerRollbackRecommendation(makeContext({ current_revision: undefined }));

    const payload = mockEmitOasisEvent.mock.calls[0][0].payload;
    expect(payload.current_revision).toBe('unknown');
  });
});

describe('triggerRollbackRecommendation() — emitOasisEvent dependency failure', () => {
  test('a thrown/rejected emit is caught and reported as emitted:false, still recommending manual rollback', async () => {
    mockEmitOasisEvent.mockRejectedValue(new Error('oasis_events insert timed out'));
    const ctx = makeContext();

    const res = await triggerRollbackRecommendation(ctx);

    expect(res).toEqual({
      emitted: false,
      recommendation: 'manual_rollback',
      detail: 'emit_failed: oasis_events insert timed out',
    });
  });

  test('a non-Error rejection value falls back to "unknown" in the detail string', async () => {
    // eslint-disable-next-line prefer-promise-reject-errors
    mockEmitOasisEvent.mockRejectedValue('a plain string rejection, not an Error');
    const ctx = makeContext();

    const res = await triggerRollbackRecommendation(ctx);

    expect(res.detail).toBe('emit_failed: unknown');
    expect(res.emitted).toBe(false);
    expect(res.recommendation).toBe('manual_rollback');
  });

  test('the function never throws even when emitOasisEvent rejects (safety net must not crash the caller)', async () => {
    mockEmitOasisEvent.mockRejectedValue(new Error('boom'));
    await expect(triggerRollbackRecommendation(makeContext())).resolves.toBeDefined();
  });
});
