/**
 * VTID-02918 (B0d.4) — wake-brief-wiring tests.
 *
 * Covers:
 *   - The wiring registers the voice-wake-brief provider exactly once
 *     (idempotent across imports).
 *   - decideWakeBriefForSession maps bucket+isReconnect → greetingPolicy
 *     via the existing A4 seam, then invokes decideContinuation.
 *   - The 3 continuation_decision_* timeline events fire in order with
 *     the expected metadata payloads.
 *   - On a non-skip greeting: returns a wake_brief continuation;
 *     wake_brief_selected event carries selected_continuation_kind.
 *   - On a skip greeting: provider suppresses, decision returns null,
 *     wake_brief_selected carries none_with_reason.
 *   - Recorder errors never escape (best-effort policy).
 */

import { decideWakeBriefForSession, ensureWakeBriefProviderRegistered } from '../../src/services/wake-brief-wiring';
import { createWakeTimelineRecorder } from '../../src/services/wake-timeline/wake-timeline-recorder';
import { defaultProviderRegistry } from '../../src/services/assistant-continuation/provider-registry';
import { VOICE_WAKE_BRIEF_PROVIDER_KEY } from '../../src/services/assistant-continuation/providers/voice-wake-brief';

describe('B0d.4 — wake-brief-wiring', () => {
  describe('provider registration', () => {
    it('voice-wake-brief is registered with the default registry on import', () => {
      const provider = defaultProviderRegistry.get(VOICE_WAKE_BRIEF_PROVIDER_KEY);
      expect(provider).toBeDefined();
      expect(provider?.surfaces).toEqual(['orb_wake']);
    });

    it('ensureWakeBriefProviderRegistered is idempotent', () => {
      // Calling twice must not throw (it would on duplicate-key register).
      expect(() => ensureWakeBriefProviderRegistered()).not.toThrow();
      expect(() => ensureWakeBriefProviderRegistered()).not.toThrow();
    });
  });

  describe('decideWakeBriefForSession', () => {
    function freshRecorder() {
      return createWakeTimelineRecorder({
        now: (() => {
          let t = 1_700_000_000_000;
          return () => {
            const d = new Date(t);
            t += 5;
            return d;
          };
        })(),
        getDb: () => null,
      });
    }

    it('returns a wake_brief continuation for a non-skip greeting', async () => {
      const recorder = freshRecorder();
      const decision = await decideWakeBriefForSession(
        {
          sessionId: 'live-test-1',
          tenantId: 't1',
          userId: 'u1',
          bucket: 'first',
          isReconnect: false,
          lang: 'en',
        },
        { recorder },
      );
      expect(decision.selectedContinuation).not.toBeNull();
      expect(decision.selectedContinuation?.kind).toBe('wake_brief');
      expect(decision.selectedContinuation?.surface).toBe('orb_wake');
      expect(decision.selectedContinuation?.userFacingLine.length).toBeGreaterThan(0);
    });

    it('suppresses on transparent reconnect (greeting policy = skip)', async () => {
      const recorder = freshRecorder();
      const decision = await decideWakeBriefForSession(
        {
          sessionId: 'live-reconnect',
          tenantId: 't1',
          userId: 'u1',
          bucket: 'recent',
          isReconnect: true,
          lang: 'en',
        },
        { recorder },
      );
      expect(decision.selectedContinuation).toBeNull();
      expect(decision.suppressionReason).toBe('all_providers_suppressed');
      // The provider's specific reason is preserved on the row.
      const row = decision.sourceProviderResults[0];
      expect(row.status).toBe('suppressed');
      expect(row.reason).toBe('greeting_policy_skip');
    });

    it('maps bucket=long to fresh_intro (warm new-day greeting)', async () => {
      const recorder = freshRecorder();
      const decision = await decideWakeBriefForSession(
        {
          sessionId: 'live-long-gap',
          tenantId: 't1',
          userId: 'u1',
          bucket: 'long',
          isReconnect: false,
          lang: 'en',
        },
        { recorder },
      );
      expect(decision.selectedContinuation?.userFacingLine).toMatch(/Hello/);
    });

    it('honors lang for the wake-brief line (de = German)', async () => {
      const recorder = freshRecorder();
      const decision = await decideWakeBriefForSession(
        {
          sessionId: 'live-de',
          tenantId: 't1',
          userId: 'u1',
          bucket: 'first',
          isReconnect: false,
          lang: 'de',
        },
        { recorder },
      );
      expect(decision.selectedContinuation?.userFacingLine).toBe('Hallo! Wie kann ich heute helfen?');
    });
  });

  describe('timeline events', () => {
    it('emits the 3 continuation_decision_* events in order', async () => {
      const recorder = createWakeTimelineRecorder({
        now: (() => {
          let t = 1_700_000_000_000;
          return () => {
            const d = new Date(t);
            t += 5;
            return d;
          };
        })(),
        getDb: () => null,
      });
      recorder.startSession({ sessionId: 'live-events' });
      await decideWakeBriefForSession(
        {
          sessionId: 'live-events',
          tenantId: 't1',
          userId: 'u1',
          bucket: 'today',
          isReconnect: false,
          lang: 'en',
        },
        { recorder },
      );
      const timeline = await recorder.getTimeline('live-events');
      const names = (timeline?.events ?? []).map((e) => e.name);
      // Order matters: started → wake_brief_selected → finished.
      expect(names).toEqual([
        'continuation_decision_started',
        'wake_brief_selected',
        'continuation_decision_finished',
      ]);
    });

    it('wake_brief_selected carries selected_continuation_kind on a returned candidate', async () => {
      const recorder = createWakeTimelineRecorder({
        now: (() => {
          let t = 1_700_000_000_000;
          return () => {
            const d = new Date(t);
            t += 5;
            return d;
          };
        })(),
        getDb: () => null,
      });
      await decideWakeBriefForSession(
        {
          sessionId: 'live-ev-kind',
          tenantId: 't1',
          userId: 'u1',
          bucket: 'first',
          isReconnect: false,
          lang: 'en',
        },
        { recorder },
      );
      const timeline = await recorder.getTimeline('live-ev-kind');
      const selected = timeline?.events.find((e) => e.name === 'wake_brief_selected');
      expect(selected?.metadata?.selected_continuation_kind).toBe('wake_brief');
      expect(selected?.metadata?.none_with_reason).toBeUndefined();
    });

    it('wake_brief_selected carries none_with_reason on full suppression', async () => {
      const recorder = createWakeTimelineRecorder({
        now: (() => {
          let t = 1_700_000_000_000;
          return () => {
            const d = new Date(t);
            t += 5;
            return d;
          };
        })(),
        getDb: () => null,
      });
      await decideWakeBriefForSession(
        {
          sessionId: 'live-ev-none',
          tenantId: 't1',
          userId: 'u1',
          bucket: 'recent',
          isReconnect: true,
          lang: 'en',
        },
        { recorder },
      );
      const timeline = await recorder.getTimeline('live-ev-none');
      const selected = timeline?.events.find((e) => e.name === 'wake_brief_selected');
      expect(selected?.metadata?.selected_continuation_kind).toBe('none_with_reason');
      expect(selected?.metadata?.none_with_reason).toBe('all_providers_suppressed');
    });

    it('continuation_decision_finished carries providerResults summary', async () => {
      const recorder = createWakeTimelineRecorder({
        now: (() => {
          let t = 1_700_000_000_000;
          return () => {
            const d = new Date(t);
            t += 5;
            return d;
          };
        })(),
        getDb: () => null,
      });
      await decideWakeBriefForSession(
        {
          sessionId: 'live-ev-final',
          tenantId: 't1',
          userId: 'u1',
          bucket: 'first',
          isReconnect: false,
          lang: 'en',
        },
        { recorder },
      );
      const timeline = await recorder.getTimeline('live-ev-final');
      const finished = timeline?.events.find((e) => e.name === 'continuation_decision_finished');
      const results = (finished?.metadata?.providerResults as Array<{ key: string; status: string }>) ?? [];
      expect(results.length).toBeGreaterThan(0);
      expect(results.find((r) => r.key === 'voice_wake_brief')).toBeDefined();
    });
  });

  describe('best-effort policy', () => {
    it('returns the decision even when the recorder throws on every call', async () => {
      const exploding = {
        startSession: () => { throw new Error('boom'); },
        recordEvent: () => { throw new Error('boom'); },
        endSession: async () => { throw new Error('boom'); },
        getTimeline: async () => null,
        listRecent: async () => [],
        reset: () => {},
      };
      const decision = await decideWakeBriefForSession(
        {
          sessionId: 'live-explode',
          tenantId: 't1',
          userId: 'u1',
          bucket: 'first',
          isReconnect: false,
          lang: 'en',
        },
        { recorder: exploding as any },
      );
      expect(decision).toBeDefined();
      expect(decision.selectedContinuation?.kind).toBe('wake_brief');
    });
  });
});
