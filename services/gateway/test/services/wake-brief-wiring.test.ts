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
      // VTID-03057 (B0d-real Xb): two providers now register on
      // orb_wake (voice-wake-brief + contextual_next_action). The
      // wake-brief test doesn't pass the next-action supabase input,
      // so next-action returns `skipped:no_next_action_inputs` while
      // voice-wake-brief returns `suppressed:greeting_policy_skip` —
      // mixed → rolled-up to `no_provider_returned_a_candidate`. The
      // important assertion is `selectedContinuation === null` (the
      // transparent-reconnect silence rule) plus the wake-brief row's
      // specific reason for diagnosability.
      expect(decision.suppressionReason).toBe('no_provider_returned_a_candidate');
      const wakeBriefRow = decision.sourceProviderResults.find(
        (r) => r.providerKey === VOICE_WAKE_BRIEF_PROVIDER_KEY,
      );
      expect(wakeBriefRow?.status).toBe('suppressed');
      expect(wakeBriefRow?.reason).toBe('greeting_policy_skip');
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
      expect(decision.selectedContinuation?.userFacingLine).toBe('Hallo! Wie kann ich dir heute helfen?');
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
      // VTID-03057: two providers now register; voice-wake-brief
      // suppresses on policy=skip while contextual_next_action skips on
      // missing inputs → rolled-up to `no_provider_returned_a_candidate`.
      expect(selected?.metadata?.none_with_reason).toBe('no_provider_returned_a_candidate');
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

  describe('VTID-03081 — B1 cadence wiring', () => {
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

    it('cadence: greeted within 15min forces policy=skip', async () => {
      const recorder = freshRecorder();
      const decision = await decideWakeBriefForSession(
        {
          sessionId: 'live-cad-1',
          tenantId: 't1',
          userId: 'u1',
          bucket: 'today',
          isReconnect: false,
          lang: 'en',
          // 5 min since we last greeted → still inside 15-min cap.
          cadenceSignals: { time_since_last_greeting_today_ms: 5 * 60 * 1000 },
        },
        { recorder },
      );
      // policy=skip → voice-wake-brief provider suppresses → no continuation.
      expect(decision.selectedContinuation).toBeNull();
      const timeline = await recorder.getTimeline('live-cad-1');
      const started = timeline?.events.find((e) => e.name === 'continuation_decision_started');
      expect(started?.metadata?.greetingPolicy).toBe('skip');
      expect(started?.metadata?.greeting_policy_reason).toBe('greeted_recently_within_window');
    });

    it('cadence: cross-surface continuation under 5 min forces policy=skip', async () => {
      const recorder = freshRecorder();
      const decision = await decideWakeBriefForSession(
        {
          sessionId: 'live-cad-2',
          tenantId: 't1',
          userId: 'u1',
          bucket: 'today',
          isReconnect: false,
          lang: 'en',
          cadenceSignals: { seconds_since_last_turn_anywhere: 90 },
        },
        { recorder },
      );
      expect(decision.selectedContinuation).toBeNull();
      const timeline = await recorder.getTimeline('live-cad-2');
      const started = timeline?.events.find((e) => e.name === 'continuation_decision_started');
      expect(started?.metadata?.greeting_policy_reason).toBe('recent_turn_continues_thread');
    });

    it('cadence: 3+ sessions today dampens fresh_intro → brief_resume', async () => {
      const recorder = freshRecorder();
      const decision = await decideWakeBriefForSession(
        {
          sessionId: 'live-cad-3',
          tenantId: 't1',
          userId: 'u1',
          bucket: 'long',
          isReconnect: false,
          lang: 'en',
          cadenceSignals: { sessions_today_count: 4 },
        },
        { recorder },
      );
      // bucket=long → default fresh_intro, but 4 sessions today drops to brief_resume.
      expect(decision.selectedContinuation?.userFacingLine).toMatch(/Welcome back/i);
    });

    it('cadence: same greeting style twice in a row downgrades one tier', async () => {
      const recorder = freshRecorder();
      const decision = await decideWakeBriefForSession(
        {
          sessionId: 'live-cad-4',
          tenantId: 't1',
          userId: 'u1',
          bucket: 'long',
          isReconnect: false,
          lang: 'en',
          cadenceSignals: { greeting_style_last_used: 'fresh_intro' },
        },
        { recorder },
      );
      // bucket=long → fresh_intro by default; previous fresh_intro → warm_return.
      expect(decision.selectedContinuation?.userFacingLine).toMatch(/welcome back|Schön, dass du wieder da bist/i);
    });

    it('timeline carries greeting policy evidence + signals present', async () => {
      const recorder = freshRecorder();
      await decideWakeBriefForSession(
        {
          sessionId: 'live-cad-5',
          tenantId: 't1',
          userId: 'u1',
          bucket: 'today',
          isReconnect: false,
          lang: 'en',
          cadenceSignals: {
            sessions_today_count: 1,
            seconds_since_last_turn_anywhere: 600,
          },
          wakeOrigin: 'orb_tap',
        },
        { recorder },
      );
      const timeline = await recorder.getTimeline('live-cad-5');
      const started = timeline?.events.find((e) => e.name === 'continuation_decision_started');
      const present = started?.metadata?.greeting_policy_signals_present as string[] | undefined;
      expect(present).toEqual(
        expect.arrayContaining(['sessions_today_count', 'seconds_since_last_turn_anywhere']),
      );
      const evidence = started?.metadata?.greeting_policy_evidence as Array<{ signal: string }>;
      expect(evidence?.length).toBeGreaterThan(0);
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
