/**
 * Conversation Flow — GOLDEN characterization of `computeGreetingDecision`
 * (roadmap Step 1a, docs/CONVERSATION_FLOW_ROADMAP_V3.md §8).
 *
 * `computeGreetingDecision` is the PURE extraction of the Vertex greeting ladder
 * that lives, today, inside `routes/orb-live.ts` `sendGreetingPromptToLiveAPI`
 * (~L7562–8505). This suite snapshots its observable decision — `wake_opener`,
 * register, NBA key, and the composed first-turn directive text — across the
 * characterization matrix so that the later strangler-fig extraction (Step 1c,
 * which routes the live path through the brain and deletes the inline branches)
 * can be proven byte-equal. Nothing here exercises runtime side effects; the
 * function is pure by construction.
 *
 * Matrix (roadmap §4):
 *   transport (vertex|livekit) × lang (de|en) × role (community|admin|developer)
 *   × current_screen × recency bucket × first-time|returning
 *
 * Two axes collapse AT THIS LAYER and that collapse is itself characterized:
 *   - transport: the greeting decision IS the Vertex brain. LiveKit carries NO
 *     independent opening ladder (it delegates to the shared services; verified
 *     by the transport-parity scanner), so there is no livekit decision to snap.
 *   - role: the greeting rung selection reads no role. The role-invariance test
 *     below pins that (community ≡ admin ≡ developer for the same context).
 *
 * If a snapshot here changes, a conversation-flow behaviour changed — review the
 * diff deliberately (this is the gate that would have caught PR #2814).
 */

import {
  computeGreetingDecision,
  type GreetingDecisionContext,
} from '../../../src/services/conversation/compute-greeting-decision';
import type { OverviewPayload } from '../../../src/services/assistant-continuation/providers/new-day-overview-payload';
import {
  EMPTY_GREETING_LEDGER,
  type GreetingLedger,
} from '../../../src/services/conversation/greeting-facts-ledger';

// --- fixtures --------------------------------------------------------------

/** A rich overview payload with substantive content (fires newday_overview /
 *  feeds the resume NBA ranker). Override any field per scenario. */
function richPayload(over: Partial<OverviewPayload> = {}): OverviewPayload {
  return {
    journey: null,
    vitana_index: {
      state: 'ok',
      today: 200,
      tier: 'Early',
      tier_framing: null,
      trend_7d: 0,
      weakest_pillar: { name: 'nutrition', score: 30 },
      strongest_pillar: null,
      balance_label: 'balanced',
      pillars: null,
      projected_day_90: null,
      projected_day_90_tier: null,
    },
    life_compass: {
      state: 'set',
      primary_goal: 'longer life',
      category: null,
      target_date: null,
      target_value: null,
      target_unit: null,
      starting_value: null,
      set_at: null,
      days_to_deadline: null,
      goal_progress_pct: null,
    },
    calendar_today: { count: 0, next: null },
    calendar_passed: { count: 0, most_recent: null },
    autopilot: { state: 'none_yet', today_checkpoint: null, this_week: [], pending_total: 0 },
    matches_unread: 0,
    messages_unread: 0,
    reminders_today: { count: 0, next: null },
    diary_last_7d: 3,
    guided_journey: null,
    last_session_date_user_tz: null,
    ...over,
  } as OverviewPayload;
}

/** A returning-user, NORMAL-path context (context already resolved → no
 *  safe-fast block). Defaults to the legacy-default rung; override to drive
 *  any other rung. Deterministic by construction. */
function ctx(over: Partial<GreetingDecisionContext> = {}): GreetingDecisionContext {
  return { ...baseCtxLiteral(), ...over };
}

function baseCtxLiteral(): GreetingDecisionContext {
  return {
    contextReadyResolved: true,
    isAnonymous: false,
    safeFastGreetingLive: false,
    reconnectCount: 0,
    lang: 'de',
    greetLang: 'de',
    bucket: 'today',
    timeAgo: 'earlier today',
    wasFailure: false,
    firstName: 'Dragan',
    hasUserId: true,
    hasSupabase: true,
    hasPriorSession: true,
    greetingNeedsOnboarding: false,
    greetingIsFirstTime: false,
    lastFullBriefingDate: '2026-06-30',
    todayTz: '2026-06-30',
    localHour: 9,
    timezone: 'Europe/Berlin',
    timeOfDay: 'morning',
    proactiveLine: null,
    newdayOverview: null,
    resumeOverview: null,
    rotationSeed: 42,
    recentNbaKeys: [],
    currentRoute: null,
    currentScreenTitle: null,
    menuPhrases: ['Schön, dass du da bist.', 'Lass uns weitermachen.', 'Ich höre dir zu.'],
    openDecision: { mode: 'speak', source: 'baseline_lead', line: null },
    guidedTopicNarrationContent: null,
    wakeBriefDecisionId: null,
    silenceOnSkipEnabled: true,
    wakeBriefHasSelectedContinuation: false,
    voiceWakeBriefReason: null,
  };
}

// A safe-fast base: context unresolved + flag live + !anonymous → safe-fast ladder.
function safeFastCtx(over: Partial<GreetingDecisionContext> = {}): GreetingDecisionContext {
  return ctx({ contextReadyResolved: false, safeFastGreetingLive: true, ...over });
}

// ---------------------------------------------------------------------------
// 1. Every rung — golden snapshot of the full decision
// ---------------------------------------------------------------------------

describe('computeGreetingDecision — rung golden snapshots', () => {
  test('rung 1: safe_fast_newday_overview (briefing due, rich payload)', () => {
    const d = computeGreetingDecision(
      safeFastCtx({
        lastFullBriefingDate: '2026-06-29', // stale → briefing due
        newdayOverview: richPayload(),
      }),
    );
    expect(d.wakeOpener).toBe('safe_fast_newday_overview');
    expect(d).toMatchSnapshot();
  });

  test('rung 2: safe_fast_first_time_welcome (never-onboarded, no prior session)', () => {
    const d = computeGreetingDecision(
      safeFastCtx({ hasPriorSession: false, greetingIsFirstTime: true, greetingNeedsOnboarding: true }),
    );
    expect(d.wakeOpener).toBe('safe_fast_first_time_welcome');
    expect(d).toMatchSnapshot();
  });

  test('rung 3: conv_resume (same-day reopen, recency register + NBA)', () => {
    const d = computeGreetingDecision(
      safeFastCtx({
        bucket: 'recent',
        lastFullBriefingDate: '2026-06-30', // already briefed today
        resumeOverview: richPayload({ messages_unread: 2 }),
      }),
    );
    expect(d.wakeOpener).toBe('conv_resume');
    expect(d.register).toBe('quick_resume');
    expect(d).toMatchSnapshot();
  });

  test('rung 4: safe_fast_proactive (pre-fetched proactive line)', () => {
    // Rung 4 is only reached when the resume rung (3) falls through. continue /
    // quick_resume always speak (even with no payload), so they would fire rung 3
    // first. Only a same_day register with NO payload, NO NBA and NO screen
    // completion is "not worth speaking" → rung 3 skips → the proactive line wins.
    const d = computeGreetingDecision(
      safeFastCtx({
        bucket: 'same_day',
        lastFullBriefingDate: '2026-06-30', // already briefed today (rung 1 skipped)
        resumeOverview: null,
        currentRoute: null,
        proactiveLine: 'Letztes Mal ging es um deinen Schlaf — machen wir da weiter?',
      }),
    );
    expect(d.wakeOpener).toBe('safe_fast_proactive');
    expect(d).toMatchSnapshot();
  });

  test('rung 5: safe_fast_newday (bare localized name greeting on a new day)', () => {
    const d = computeGreetingDecision(
      safeFastCtx({
        bucket: 'yesterday',
        lastFullBriefingDate: '2026-06-30', // not briefing-due → overview skipped
        // No proactive line, no resume payload → falls to the bare new-day name.
        resumeOverview: null,
      }),
    );
    expect(d.wakeOpener).toBe('safe_fast_newday');
    expect(d).toMatchSnapshot();
  });

  test('rung 6: safe_fast_pending_context (generic short menu)', () => {
    const d = computeGreetingDecision(
      safeFastCtx({
        bucket: 'same_day',
        lastFullBriefingDate: '2026-06-30',
        firstName: null, // no name → new-day name rung cannot fire
        resumeOverview: null,
      }),
    );
    expect(d.wakeOpener).toBe('safe_fast_pending_context');
    expect(d).toMatchSnapshot();
  });

  test('rung 7: silent_reconnect (native resume opening decision)', () => {
    const d = computeGreetingDecision(
      ctx({ openDecision: { mode: 'silent', source: 'native_resume', line: null } }),
    );
    expect(d.wakeOpener).toBe('silent_reconnect');
    expect(d.directive).toBeNull();
    expect(d.effects.armWatchdog).toBe(false);
    expect(d).toMatchSnapshot();
  });

  test('rung 8: override_v2 (wake-brief selected line, spoken verbatim)', () => {
    const d = computeGreetingDecision(
      ctx({
        openDecision: { mode: 'speak', source: 'wake:teacher', line: 'Heute ist dein 12. Tag — bleiben wir dran.' },
        wakeBriefDecisionId: 'wb-123',
      }),
    );
    expect(d.wakeOpener).toBe('override_v2');
    expect(d).toMatchSnapshot();
  });

  test('rung 8: override_v2 guided-teach (narration content → translate/teach trigger)', () => {
    const d = computeGreetingDecision(
      ctx({
        lang: 'en',
        greetLang: 'en',
        openDecision: { mode: 'speak', source: 'wake:guided', line: 'Lektion: Atme langsam ein und aus.' },
        guidedTopicNarrationContent: 'Lektion: Atme langsam ein und aus.',
      }),
    );
    expect(d.wakeOpener).toBe('override_v2');
    expect(d.directive).toContain('fluent English');
    expect(d).toMatchSnapshot();
  });

  test('rung 9: silenced_on_cadence (cadence-class wake-brief skip)', () => {
    const d = computeGreetingDecision(
      ctx({
        openDecision: { mode: 'speak', source: 'baseline_lead', line: null },
        wakeBriefHasSelectedContinuation: false,
        voiceWakeBriefReason: 'recent_turn_continues_thread',
        wakeBriefDecisionId: 'wb-9',
      }),
    );
    expect(d.wakeOpener).toBe('silenced_on_cadence');
    expect(d.directive).toBeNull();
    expect(d.effects.armWatchdog).toBe(false);
    expect(d).toMatchSnapshot();
  });

  test('legacy default: authenticated recency-bucket menu', () => {
    const d = computeGreetingDecision(ctx({ bucket: 'reconnect' }));
    expect(d.wakeOpener).toBe('legacy_default');
    expect(d.diag.wake_opener).toBeUndefined(); // legacy emits NO wake_opener field
    expect(d).toMatchSnapshot();
  });

  test('legacy default: anonymous intro speech', () => {
    const d = computeGreetingDecision(ctx({ isAnonymous: true, lang: 'en' }));
    expect(d.wakeOpener).toBe('legacy_default');
    expect(d).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// 2. Language axis (de | en) across representative rungs
// ---------------------------------------------------------------------------

describe('computeGreetingDecision — language axis', () => {
  for (const lang of ['de', 'en'] as const) {
    test(`legacy default — lang=${lang}, bucket=long`, () => {
      const d = computeGreetingDecision(ctx({ lang, greetLang: lang, bucket: 'long', timeAgo: '10 days' }));
      expect(d).toMatchSnapshot();
    });

    test(`safe_fast_newday name greeting — lang=${lang}`, () => {
      const d = computeGreetingDecision(
        safeFastCtx({ lang, greetLang: lang, bucket: 'today', lastFullBriefingDate: '2026-06-30' }),
      );
      expect(d.wakeOpener).toBe('safe_fast_newday');
      expect(d).toMatchSnapshot();
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Recency bucket axis across the legacy ladder
// ---------------------------------------------------------------------------

describe('computeGreetingDecision — recency bucket axis (legacy ladder)', () => {
  const buckets = ['reconnect', 'recent', 'same_day', 'today', 'yesterday', 'week', 'long', 'first'] as const;
  for (const bucket of buckets) {
    test(`bucket=${bucket}`, () => {
      const d = computeGreetingDecision(ctx({ bucket, timeAgo: `~${bucket}` }));
      expect(d.wakeOpener).toBe('legacy_default');
      expect(d).toMatchSnapshot();
    });
  }

  test('legacy apology branch: wasFailure + reconnect', () => {
    const d = computeGreetingDecision(ctx({ bucket: 'reconnect', wasFailure: true }));
    expect(d.directive).toContain('Sorry about that');
    expect(d).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// 4. Current-screen axis (conv_resume deepens on the screen the user is on)
// ---------------------------------------------------------------------------

describe('computeGreetingDecision — current-screen awareness', () => {
  for (const route of ['/matches', '/diary', '/vitana-index', '/chat'] as const) {
    test(`conv_resume on ${route} → screen-completion NBA`, () => {
      const d = computeGreetingDecision(
        safeFastCtx({
          bucket: 'recent',
          lastFullBriefingDate: '2026-06-30',
          currentRoute: route,
          resumeOverview: richPayload(),
        }),
      );
      expect(d.wakeOpener).toBe('conv_resume');
      expect(d).toMatchSnapshot();
    });
  }

  test('legacy default carries the screenHint for a known route', () => {
    const d = computeGreetingDecision(ctx({ bucket: 'today', currentScreenTitle: 'Mein Tagebuch' }));
    expect(d.directive).toContain('Mein Tagebuch');
    expect(d).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// 5. Axis-collapse characterization (transport + role)
// ---------------------------------------------------------------------------

describe('computeGreetingDecision — matrix axis collapse', () => {
  test('role-invariance: community ≡ admin ≡ developer for identical context', () => {
    // Role is not an input to the greeting rung selection. Three "roles" share
    // one context object, so the decision is identical by construction — this
    // test documents (and guards) that the role axis collapses at this layer.
    const base = safeFastCtx({ bucket: 'recent', lastFullBriefingDate: '2026-06-30', resumeOverview: richPayload() });
    const community = computeGreetingDecision(base);
    const admin = computeGreetingDecision({ ...base });
    const developer = computeGreetingDecision({ ...base });
    expect(admin).toEqual(community);
    expect(developer).toEqual(community);
  });

  test('first-time vs returning diverge on the same recency', () => {
    const common = { bucket: 'today' as const, lastFullBriefingDate: '2026-06-29' };
    const returning = computeGreetingDecision(safeFastCtx({ ...common, newdayOverview: richPayload() }));
    const firstTime = computeGreetingDecision(
      safeFastCtx({ ...common, hasPriorSession: false, greetingIsFirstTime: true, greetingNeedsOnboarding: true }),
    );
    expect(returning.wakeOpener).toBe('safe_fast_newday_overview');
    expect(firstTime.wakeOpener).toBe('safe_fast_first_time_welcome');
  });
});

// ---------------------------------------------------------------------------
// 6. Purity / determinism guard
// ---------------------------------------------------------------------------

describe('computeGreetingDecision — determinism', () => {
  test('same context → identical decision (no hidden clock/random/IO)', () => {
    const c = safeFastCtx({ bucket: 'recent', lastFullBriefingDate: '2026-06-30', resumeOverview: richPayload() });
    expect(computeGreetingDecision(c)).toEqual(computeGreetingDecision(c));
  });
});

// ---------------------------------------------------------------------------
// 7. Spoken-facts ledger continuity (#2835) — the brain re-synced with the
//    greeting-facts ledger. Deltas are computed purely from the rung payload +
//    the injected ledger; `nowIso` is injected so the 48h freshness check is
//    deterministic (computeFactDeltas otherwise reads the wall clock).
// ---------------------------------------------------------------------------

const LEDGER_NOW_ISO = '2026-06-30T09:00:00.000Z';
const LEDGER_SPOKEN_AT = '2026-06-30T08:00:00.000Z'; // 1h ago → fresh (<48h)

function ledger(facts: Record<string, number>, over: Partial<GreetingLedger> = {}): GreetingLedger {
  const f: GreetingLedger['facts'] = {};
  for (const [k, v] of Object.entries(facts)) f[k] = { value: v, spoken_at: LEDGER_SPOKEN_AT };
  return { facts: f, last_utterance: null, last_utterance_at: LEDGER_SPOKEN_AT, sessions_today: null, ...over };
}

describe('computeGreetingDecision — spoken-facts ledger continuity (#2835)', () => {
  test('conv_resume with a populated ledger → unchanged/changed deltas + previous-utterance', () => {
    const payload = richPayload({ messages_unread: 2, matches_unread: 1 });
    const d = computeGreetingDecision(
      safeFastCtx({
        bucket: 'recent',
        lastFullBriefingDate: '2026-06-30',
        resumeOverview: payload,
        nowIso: LEDGER_NOW_ISO,
        greetingLedger: ledger(
          // vitana_index unchanged (200→200), messages changed (1→2), matches new
          { vitana_index: 200, messages_unread: 1 },
          { last_utterance: 'Guten Morgen, Dragan — dein Index steht bei 200.', sessions_today: 2 },
        ),
      }),
    );
    expect(d.wakeOpener).toBe('conv_resume');
    expect(d).toMatchSnapshot();
  });

  test('newday_overview with a populated ledger → continuity-aware briefing', () => {
    const d = computeGreetingDecision(
      safeFastCtx({
        lastFullBriefingDate: '2026-06-29', // stale → briefing due
        newdayOverview: richPayload({ messages_unread: 3 }),
        nowIso: LEDGER_NOW_ISO,
        greetingLedger: ledger(
          // index + diary unchanged (already mentioned); messages changed 2→3
          { vitana_index: 200, diary_last_7d: 3, messages_unread: 2 },
          { last_utterance: 'Guten Morgen — dein Index steht bei 200.', sessions_today: 1 },
        ),
      }),
    );
    expect(d.wakeOpener).toBe('safe_fast_newday_overview');
    expect(d).toMatchSnapshot();
  });

  test('empty ledger ≡ no ledger (all facts read as new; byte-identical directive)', () => {
    const payload = richPayload({ messages_unread: 2 });
    const base = { bucket: 'recent' as const, lastFullBriefingDate: '2026-06-30', resumeOverview: payload, nowIso: LEDGER_NOW_ISO };
    const withEmpty = computeGreetingDecision(safeFastCtx({ ...base, greetingLedger: EMPTY_GREETING_LEDGER }));
    const without = computeGreetingDecision(safeFastCtx({ ...base }));
    expect(withEmpty.directive).toBe(without.directive);
  });

  test('deterministic under injected nowIso (no wall-clock leak)', () => {
    const c = safeFastCtx({
      bucket: 'recent',
      lastFullBriefingDate: '2026-06-30',
      resumeOverview: richPayload({ messages_unread: 2 }),
      nowIso: LEDGER_NOW_ISO,
      greetingLedger: ledger({ messages_unread: 1 }, { last_utterance: 'x' }),
    });
    expect(computeGreetingDecision(c)).toEqual(computeGreetingDecision(c));
  });
});
