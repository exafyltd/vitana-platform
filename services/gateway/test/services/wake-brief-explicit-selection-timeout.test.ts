/**
 * VTID-03741 follow-up (Codex review finding, P1) — an explicit Guided
 * Journey tap must not lose to the parallel ranker's generic per-provider
 * timeout.
 *
 * decideContinuation's ranker (VTID-03741) now runs its ~10 providers
 * concurrently, each bounded by a per-provider timeout sized for the
 * passive/ambient providers (DEFAULT_PROVIDER_TIMEOUT_MS, 800ms — a handful
 * of fast indexed reads). guided-topic-narration additionally awaits real
 * Polly synthesis on a cache miss (synthesizeGuidedTopicNarrationAudio
 * inside its produce()), which can plausibly exceed 800ms for a cold
 * lesson — and per wake-brief-wiring.ts's own `isExplicitSelection` comment,
 * an explicitly tapped topic MUST lead turn 1. A timeout there doesn't just
 * slow the turn down: it silently drops the explicitly-requested candidate
 * and a lower-priority provider opens a generic conversation instead — the
 * exact "tapping a lesson opens small talk" defect the VTID-03644->03686
 * chain fought to fix.
 *
 * Fix: decideWakeBriefForSession passes a generous
 * EXPLICIT_SELECTION_PROVIDER_TIMEOUT_MS (10s) to decideContinuation
 * whenever `guidedTopicId` or `journeyFocusStep` is set, instead of falling
 * through to the 800ms ambient default. This test mocks decideContinuation
 * to pin exactly what decideWakeBriefForSession passes it — the actual
 * ranking/timeout-racing behavior is already covered by
 * decide-continuation.test.ts's "VTID-03741 parallel ranker" suite.
 */

import type { AssistantContinuationDecision } from '../../src/services/assistant-continuation/types';

const decideContinuationMock = jest.fn<Promise<AssistantContinuationDecision>, [any]>();

jest.mock('../../src/services/assistant-continuation/decide-continuation', () => ({
  decideContinuation: (...args: any[]) => decideContinuationMock(...args),
}));

// Imported AFTER the mock so wake-brief-wiring picks up the mocked module.
import { decideWakeBriefForSession } from '../../src/services/wake-brief-wiring';
import { createWakeTimelineRecorder } from '../../src/services/wake-timeline/wake-timeline-recorder';

function freshRecorder() {
  return createWakeTimelineRecorder({ now: () => new Date(1_700_000_000_000), getDb: () => null });
}

function stubDecision(): AssistantContinuationDecision {
  return {
    decisionId: 'd-1',
    selectedContinuation: null,
    decisionStartedAt: new Date(0).toISOString(),
    decisionFinishedAt: new Date(0).toISOString(),
    sourceProviderResults: [],
    telemetryContext: { surface: 'orb_wake' },
    suppressionReason: 'all_providers_suppressed',
  };
}

describe('VTID-03741 follow-up: explicit-selection turns get a longer ranker timeout', () => {
  beforeEach(() => {
    decideContinuationMock.mockReset();
    decideContinuationMock.mockResolvedValue(stubDecision());
  });

  it('passes providerTimeoutMs=10000 when a Guided Journey topic was explicitly tapped', async () => {
    await decideWakeBriefForSession(
      {
        sessionId: 's1',
        tenantId: 't1',
        userId: 'u1',
        bucket: 'first',
        isReconnect: false,
        lang: 'en',
        guidedTopicId: 'T253',
      },
      { recorder: freshRecorder() },
    );

    expect(decideContinuationMock).toHaveBeenCalledTimes(1);
    const opts = decideContinuationMock.mock.calls[0][0];
    expect(opts.providerTimeoutMs).toBe(10_000);
  });

  it('passes providerTimeoutMs=10000 when a Foundation journey-focus step was explicitly tapped', async () => {
    await decideWakeBriefForSession(
      {
        sessionId: 's2',
        tenantId: 't1',
        userId: 'u1',
        bucket: 'first',
        isReconnect: false,
        lang: 'en',
        journeyFocusStep: 'life_compass',
      },
      { recorder: freshRecorder() },
    );

    const opts = decideContinuationMock.mock.calls[0][0];
    expect(opts.providerTimeoutMs).toBe(10_000);
  });

  it('does NOT set providerTimeoutMs on a passive/ambient open (falls through to the ranker default)', async () => {
    await decideWakeBriefForSession(
      {
        sessionId: 's3',
        tenantId: 't1',
        userId: 'u1',
        bucket: 'first',
        isReconnect: false,
        lang: 'en',
      },
      { recorder: freshRecorder() },
    );

    const opts = decideContinuationMock.mock.calls[0][0];
    expect(opts.providerTimeoutMs).toBeUndefined();
  });
});
