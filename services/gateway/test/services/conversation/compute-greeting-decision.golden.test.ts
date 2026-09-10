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
  setNewdayOverviewRungEnabled,
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
    facts_learned_since_last: null,
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

  // VTID-03646 — was "(wake-brief selected line, spoken verbatim)". The line is
  // no longer spoken verbatim: it is a LEAD the model builds substance +
  // next step + confirmation on. The old snapshot pinned the dead-end
  // directive ("ONE short utterance... NO question after") that produced the
  // reported "announce, then listen" opening, and is deliberately re-recorded.
  test('rung 8: override_v2 (wake-brief selected line, used as the turn lead)', () => {
    const d = computeGreetingDecision(
      ctx({
        openDecision: { mode: 'speak', source: 'wake:teacher', line: 'Heute ist dein 12. Tag — bleiben wir dran.' },
        wakeBriefDecisionId: 'wb-123',
      }),
    );
    expect(d.wakeOpener).toBe('override_v2');
    expect(d).toMatchSnapshot();
  });

  // BOOTSTRAP-ORB-PERSONALIZED-GREETING — reported live: "a simple good
  // morning is not enough, it must be personalized: Good morning Claudia."
  // override_v2 is the dominant opener (24/24 sessions per VTID-03646's own
  // measurement), so a known name must be a hard requirement here, not just
  // on the rarely-reached safe_fast_newday rung (rung 5).
  test('rung 8: override_v2 with a known name → HARD RULE requires a name-based greeting', () => {
    const d = computeGreetingDecision(
      ctx({
        firstName: 'Claudia',
        openDecision: { mode: 'speak', source: 'wake:teacher', line: 'Du hast 3 neue Nachrichten.' },
      }),
    );
    expect(d.wakeOpener).toBe('override_v2');
    expect(d.directive).toContain('The user\'s name is "Claudia"');
    expect(d.directive).toMatch(/HARD RULE/);
    expect(d.directive).not.toMatch(/Do not greet the user by name first/);
  });

  test('rung 8: override_v2 with no known name → does not invent one, no hard-rule text', () => {
    const d = computeGreetingDecision(
      ctx({
        firstName: null,
        openDecision: { mode: 'speak', source: 'wake:teacher', line: 'Du hast 3 neue Nachrichten.' },
      }),
    );
    expect(d.wakeOpener).toBe('override_v2');
    expect(d.directive).toMatch(/greet warmly without inventing or guessing one/);
    expect(d.directive).not.toMatch(/HARD RULE/);
  });

  test('rung 8: override_v2 guided-teach (narration content → SAME plain trigger as every other provider, VTID-03674)', () => {
    // VTID-03674: guided-topic candidates used to get a special "translate it
    // faithfully and completely... do NOT summarize" trigger. Live evidence
    // showed that wrapper itself (not lesson length/content) tripped Nova's
    // content filter on a real production session, even wrapping a short
    // opener line. Guided-teach candidates now use the identical plain
    // wakeTriggerByLang template every other provider already uses
    // successfully — no special-casing left to diverge.
    const d = computeGreetingDecision(
      ctx({
        lang: 'en',
        greetLang: 'en',
        openDecision: { mode: 'speak', source: 'wake:guided', line: 'Lektion: Atme langsam ein und aus.' },
        guidedTopicNarrationContent: 'Lektion: Atme langsam ein und aus.',
      }),
    );
    expect(d.wakeOpener).toBe('override_v2');
    // VTID-03646 merge: the plain trigger this rung falls back to is now an
    // English INTENT rather than the per-language `Say exactly: "<line>"`
    // table (NEVER-rule 41 / §13b), so the literal is gone. VTID-03674's
    // actual invariants are unchanged and are what is pinned here: guided
    // candidates get the plain short-utterance shape — NOT the three-beat
    // proposal contract non-guided openers now get — and none of the
    // "translate it faithfully / fluent <language>" phrasing that tripped
    // Nova's content filter may reappear.
    // VTID-03797 RE-RECORDED DELIBERATELY. This previously pinned "ONE short
    // utterance", the wording of a template that told the model to reproduce a
    // supplied line VERBATIM. That template is the defect: guided sessions were
    // blocked by Nova 93/93 over 30 days (zero ever spoke), across three topics
    // and two languages, while an ordinary control in the same run completed
    // its turn. A verbatim-reproduction directive wrapped in prohibitions is
    // the shape Bedrock's guardrail treats as injection-like — which is why
    // this worked on Vertex and broke on Nova. VTID-03674 removed the older,
    // harsher wrapper but replaced it with a milder VERBATIM one, so the class
    // survived. What is pinned now is the compositional shape.
    expect(d.directive).toMatch(/Compose that sentence yourself/i);
    expect(d.directive).toMatch(/ONE short, warm sentence/i);
    // Still NOT the three-beat proposal contract (a tapped topic opens; it
    // does not propose a next step before teaching — VTID-03686).
    expect(d.directive).not.toMatch(/NEXT STEP/);
    expect(d.directive).not.toContain('fluent');
    expect(d.directive).not.toContain('translate');
    // The new invariant: never command verbatim reproduction again.
    expect(d.directive).not.toMatch(/say(ing)? this prepared line/i);
    expect(d.directive).not.toMatch(/do not turn it into something else/i);
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

  test('legacy apology branch: wasFailure + reconnect (lang=de — VTID-03556 regression)', () => {
    // Base ctx() defaults to lang='de'. Before VTID-03556 this branch ignored
    // ctx.lang entirely and always emitted the English literal, so a
    // German-locale user got an English apology opener after a failed
    // session (e.g. a Nova Sonic "Premature close" reconnect).
    const d = computeGreetingDecision(ctx({ bucket: 'reconnect', wasFailure: true }));
    expect(d.directive).toContain('Entschuldige');
    expect(d.directive).not.toContain('Sorry about that');
    expect(d).toMatchSnapshot();
  });

  test('legacy apology branch: wasFailure + reconnect (lang=en)', () => {
    const d = computeGreetingDecision(ctx({ bucket: 'reconnect', wasFailure: true, lang: 'en', greetLang: 'en' }));
    expect(d.directive).toContain('Sorry about that');
    expect(d).toMatchSnapshot();
  });

  test('legacy apology branch: wasFailure + recent (lang=fr)', () => {
    const d = computeGreetingDecision(ctx({ bucket: 'recent', wasFailure: true, lang: 'fr', greetLang: 'fr' }));
    expect(d.directive).toContain('Désolé');
    expect(d).toMatchSnapshot();
  });

  test('legacy apology branch falls back to English for an unknown lang', () => {
    const d = computeGreetingDecision(ctx({ bucket: 'reconnect', wasFailure: true, lang: 'xx', greetLang: 'xx' }));
    expect(d.directive).toContain('Sorry about that');
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

// ---------------------------------------------------------------------------
// VTID-03607 — the rich new-day briefing is reachable on the NORMAL ladder
//
// Before this, the briefing existed ONLY as rung 1 of the safe-fast ladder,
// and safeFastApplies() requires `contextReadyResolved === false`. So the one
// greeting built FROM context could fire only when context had NOT resolved,
// and was skipped entirely whenever it had. Every speedup to context assembly
// therefore made the briefing rarer — which is how a user on a genuine new day
// ended up hearing the generic wake-brief one-liner from rung 8 instead
// (prod session live-37aa4388, 2026-08-11: bootstrap 16ms, no
// `greeting_context_pending`, wake_opener `override_v2`).
// ---------------------------------------------------------------------------

describe('computeGreetingDecision — VTID-03607 new-day briefing on the normal ladder', () => {
  const dueNormalCtx = (over: Partial<GreetingDecisionContext> = {}) =>
    ctx({
      lastFullBriefingDate: '2026-06-29', // stale → briefing due
      newdayOverview: richPayload({ messages_unread: 3 }),
      ...over,
    });

  test('briefing due + rich payload + context resolved → newday_overview, not override_v2', () => {
    const d = computeGreetingDecision(
      dueNormalCtx({ openDecision: { mode: 'speak', source: 'baseline_lead', line: 'Dein Index hat sich bewegt.' } }),
    );
    expect(d.wakeOpener).toBe('newday_overview');
    expect(d.register).toBe('daily_briefing');
    expect(d.effects.stampBriefingDate).toBe('2026-06-30');
  });

  test('the briefing outranks a wake-brief line that would otherwise fire rung 8', () => {
    const withLine = { openDecision: { mode: 'speak' as const, source: 'baseline_lead', line: 'Etwas Kurzes.' } };
    // Without the payload the same context still fires override_v2 — so the
    // ordering, not the absence of a line, is what this test pins.
    expect(computeGreetingDecision(ctx({ ...withLine })).wakeOpener).toBe('override_v2');
    expect(computeGreetingDecision(dueNormalCtx(withLine)).wakeOpener).toBe('newday_overview');
  });

  test('a silent reconnect still wins — a briefing is the loudest thing to say into one', () => {
    const d = computeGreetingDecision(
      dueNormalCtx({ openDecision: { mode: 'silent', source: 'native_resume', line: null } }),
    );
    expect(d.wakeOpener).toBe('silent_reconnect');
    expect(d.directive).toBeNull();
  });

  test('already briefed today → does NOT fire again (once per calendar day)', () => {
    const d = computeGreetingDecision(
      dueNormalCtx({
        lastFullBriefingDate: '2026-06-30', // == todayTz
        openDecision: { mode: 'speak', source: 'baseline_lead', line: 'Etwas Kurzes.' },
      }),
    );
    expect(d.wakeOpener).not.toBe('newday_overview');
  });

  test('no payload gathered → normal ladder is byte-identical to before', () => {
    const withLine = { openDecision: { mode: 'speak' as const, source: 'baseline_lead', line: 'Etwas Kurzes.' } };
    const before = computeGreetingDecision(ctx({ ...withLine, lastFullBriefingDate: '2026-06-29' }));
    expect(before.wakeOpener).toBe('override_v2');
    expect(before.directive).toContain('Etwas Kurzes.');
  });

  test('an empty payload (nothing worth saying) does not hijack the turn', () => {
    const d = computeGreetingDecision(
      dueNormalCtx({
        newdayOverview: richPayload({
          journey: null,
          vitana_index: { state: 'none' } as never,
          life_compass: { state: 'unset' } as never,
          calendar_today: { count: 0, items: [] } as never,
          calendar_passed: { count: 0, items: [] } as never,
          autopilot: { state: 'none' } as never,
          matches_unread: 0,
          messages_unread: 0,
          reminders_today: { count: 0, items: [] } as never,
        }),
        openDecision: { mode: 'speak', source: 'baseline_lead', line: 'Etwas Kurzes.' },
      }),
    );
    expect(d.wakeOpener).toBe('override_v2');
  });

  test('both ladders produce the SAME directive for the same payload — one implementation', () => {
    const shared = {
      lastFullBriefingDate: '2026-06-29',
      newdayOverview: richPayload({ messages_unread: 3 }),
    };
    const fast = computeGreetingDecision(safeFastCtx(shared));
    const normal = computeGreetingDecision(ctx(shared));
    expect(fast.wakeOpener).toBe('safe_fast_newday_overview');
    expect(normal.wakeOpener).toBe('newday_overview');
    expect(normal.directive).toBe(fast.directive);
    expect(normal.effects.stampBriefingDate).toBe(fast.effects.stampBriefingDate);
  });
});

// ---------------------------------------------------------------------------
// VTID-03724 — a tapped guided topic outranks day_close/newday_overview on
// BOTH ladders. Live report: "tapping a session starts my new day greeting
// overview... it does not start the session." Confirmed via oasis_events —
// the wake-brief ranker correctly selected the guided-topic candidate
// (winner:true, dedupe_key:"guided_topic:T001") and the session's own
// greeting_sent event STILL reported wake_opener:"newday_overview" moments
// later, because newday_overview never checked for a pending guided-topic
// tap before this fix.
// ---------------------------------------------------------------------------
describe('computeGreetingDecision — VTID-03724 guided-topic tap outranks passive rungs', () => {
  const collidingContext = {
    lastFullBriefingDate: '2026-06-29', // stale → newday_overview is due
    newdayOverview: richPayload({ messages_unread: 3 }), // has content → would fire
    guidedTopicNarrationContent: 'Lektion: Atme langsam ein und aus.',
    openDecision: {
      mode: 'speak' as const,
      source: 'wake:guided',
      line: 'Lass uns über Atmung sprechen.',
    },
  };

  test('normal ladder: a guided-topic tap wins over a due, content-rich newday_overview', () => {
    const withoutGuided = computeGreetingDecision(
      ctx({ ...collidingContext, guidedTopicNarrationContent: null }),
    );
    // Sanity: without the guided tap, this exact context DOES fire the
    // briefing — proving the collision is real, not a fixture artifact.
    expect(withoutGuided.wakeOpener).toBe('newday_overview');

    const withGuided = computeGreetingDecision(ctx(collidingContext));
    expect(withGuided.wakeOpener).toBe('override_v2');
    // VTID-03797 RE-RECORDED: this asserted the provider's spoken line was
    // embedded VERBATIM in the directive — the exact defect (see the rung-8
    // guided-teach test above). The load-bearing invariant of VTID-03724 is
    // that the guided tap WINS this collision, which is asserted on the line
    // above and is unchanged; the directive is now compositional.
    expect(withGuided.directive).toMatch(/Compose that sentence yourself/i);
    expect(withGuided.directive).not.toContain('Lass uns über Atmung sprechen.');
    // The briefing must not be silently stamped as delivered when it never
    // spoke — a real briefing should still be owed next time.
    expect(withGuided.effects.stampBriefingDate).toBeUndefined();
  });

  test('safe-fast ladder: same collision, same fix — this ladder had NO guided-topic handling before', () => {
    const withoutGuided = computeGreetingDecision(
      safeFastCtx({ ...collidingContext, guidedTopicNarrationContent: null }),
    );
    expect(withoutGuided.wakeOpener).toBe('safe_fast_newday_overview');

    const withGuided = computeGreetingDecision(safeFastCtx(collidingContext));
    expect(withGuided.wakeOpener).toBe('override_v2');
    // VTID-03797 RE-RECORDED (same reason as the normal-ladder test above).
    expect(withGuided.directive).toMatch(/Compose that sentence yourself/i);
    expect(withGuided.directive).not.toContain('Lass uns über Atmung sprechen.');

    // VTID-03797 ANTI-DRIFT: both ladders must emit the IDENTICAL guided
    // directive. They previously held byte-identical COPIES of the template
    // while a comment claimed they "can never drift apart on this again" —
    // and they did drift the moment one copy was edited (the live path is
    // tryGuidedTopicRung, so editing the rung-8 copy alone changed nothing in
    // production). One shared builder now backs both; this pins that.
    const normalLadder = computeGreetingDecision(ctx(collidingContext));
    expect(withGuided.directive).toBe(normalLadder.directive);
  });

  test('a guided tap with no wake-brief line yet falls through — nothing to say, so the briefing may still fire', () => {
    // Defensive edge case: guidedTopicNarrationContent set but the wake-brief
    // line itself hasn't resolved (openDecision silent/empty). Nothing to
    // speak for the guided rung, so the ladder must not hang — it falls
    // through to the next real rung instead of asserting on the same event.
    const d = computeGreetingDecision(
      ctx({ ...collidingContext, openDecision: { mode: 'silent', source: 'x', line: null } }),
    );
    expect(d.wakeOpener).not.toBe('override_v2');
  });

  test('day_close also yields to a guided-topic tap (same defect class, night window)', () => {
    const nightCtx = ctx({
      ...collidingContext,
      newdayOverview: null, // isolate day_close specifically
      localHour: 22,
      lastDayCloseDate: null,
      isAnonymous: false,
    });
    const withoutGuided = computeGreetingDecision({ ...nightCtx, guidedTopicNarrationContent: null });
    expect(withoutGuided.wakeOpener).toBe('day_close');

    const withGuided = computeGreetingDecision(nightCtx);
    expect(withGuided.wakeOpener).toBe('override_v2');
  });

  test('anonymous sessions are unaffected — override_v2/guided rung never fires for them, same as before', () => {
    const d = computeGreetingDecision(ctx({ ...collidingContext, isAnonymous: true }));
    expect(d.wakeOpener).not.toBe('override_v2');
  });

  test('a genuine silent reconnect still wins over a guided tap — transport signal, not a new opening', () => {
    const d = computeGreetingDecision(
      ctx({ ...collidingContext, openDecision: { mode: 'silent', source: 'native_resume', line: null } }),
    );
    expect(d.wakeOpener).toBe('silent_reconnect');
  });

  test('no guided topic, no collision → both ladders are byte-identical to before this fix', () => {
    const plain = { lastFullBriefingDate: '2026-06-29', newdayOverview: richPayload({ messages_unread: 3 }) };
    expect(computeGreetingDecision(ctx(plain)).wakeOpener).toBe('newday_overview');
    expect(computeGreetingDecision(safeFastCtx(plain)).wakeOpener).toBe('safe_fast_newday_overview');
  });
});

// ---------------------------------------------------------------------------
// VTID-03628 — P0 emergency kill switch for the new-day overview rung.
// ---------------------------------------------------------------------------
describe('setNewdayOverviewRungEnabled — new-day overview kill switch', () => {
  afterEach(() => {
    // This module's own default is enabled — restore it so no other test
    // file in the same worker inherits a disabled switch.
    setNewdayOverviewRungEnabled(true);
  });

  const richContext = {
    lastFullBriefingDate: '2026-06-29', // stale -> briefing due
    newdayOverview: richPayload({ messages_unread: 3 }),
  };

  test('defaults to enabled — unchanged behaviour for any caller that never touches the switch', () => {
    const fast = computeGreetingDecision(safeFastCtx(richContext));
    const normal = computeGreetingDecision(ctx(richContext));
    expect(fast.wakeOpener).toBe('safe_fast_newday_overview');
    expect(normal.wakeOpener).toBe('newday_overview');
  });

  test('disabling makes BOTH ladders fall through to a later rung instead of failing', () => {
    setNewdayOverviewRungEnabled(false);
    const fast = computeGreetingDecision(safeFastCtx(richContext));
    const normal = computeGreetingDecision(ctx(richContext));
    expect(fast.wakeOpener).not.toBe('safe_fast_newday_overview');
    expect(normal.wakeOpener).not.toBe('newday_overview');
    // Falls through to a real rung, not a crash/undefined.
    expect(typeof fast.wakeOpener).toBe('string');
    expect(typeof normal.wakeOpener).toBe('string');
  });

  test('re-enabling restores the rung for the identical context', () => {
    setNewdayOverviewRungEnabled(false);
    expect(computeGreetingDecision(ctx(richContext)).wakeOpener).not.toBe('newday_overview');
    setNewdayOverviewRungEnabled(true);
    expect(computeGreetingDecision(ctx(richContext)).wakeOpener).toBe('newday_overview');
  });
});
