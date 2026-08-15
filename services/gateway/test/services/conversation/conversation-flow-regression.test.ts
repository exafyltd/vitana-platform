/**
 * VTID-03646 — regression suite for the reported conversation-flow collapse:
 * "Vitana starts the voice conversation with 'ich zeige dir die neuesten
 * Nachrichten' and then opens listening mode."
 *
 * Three independent defects stacked into that one symptom, and each gets its
 * own pins here, because fixing any two of them still leaves the report true:
 *
 *   A. The rich new-day briefing guard required a first name that PRODUCTION
 *      never has. Measured on prod 2026-08-15: every `newday_briefing_eval`
 *      that day reported `outcome:guard_rejected` with `has_first_name:false`
 *      and `facts_ready_awaited:false`, because the greeting-facts prefetch is
 *      gated on `FEATURE_ORB_SAFE_FAST_GREETING`, which is `staging-only`.
 *   B. The rung was ALSO kill-switched off (VTID-03628), on a theory
 *      VTID-03629 itself then disproved.
 *   C. Everything therefore landed on `override_v2`, whose directive ordered
 *      ONE short utterance with "NO question after" — an announcement with no
 *      substance, no proposal and no confirmation, followed by silence.
 *
 * The product contract these pins protect is the one the report describes:
 * real content → one concrete next step → ask for confirmation.
 */

import {
  computeGreetingDecision,
  shouldAttemptNewdayOverview,
  setNewdayOverviewRungEnabled,
  type GreetingDecisionContext,
} from '../../../src/services/conversation/compute-greeting-decision';
import type { OverviewPayload } from '../../../src/services/assistant-continuation/providers/new-day-overview-payload';

function payload(over: Partial<OverviewPayload> = {}): OverviewPayload {
  return {
    journey: null,
    vitana_index: {
      state: 'ok',
      today: 200,
      tier: 'Early',
      tier_framing: null,
      trend_7d: 4,
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
    messages_unread: 3,
    reminders_today: { count: 0, next: null },
    diary_last_7d: 3,
    facts_learned_since_last: null,
    guided_journey: null,
    last_session_date_user_tz: null,
    ...over,
  } as OverviewPayload;
}

/** A returning German user on the NORMAL ladder, briefing due. */
function ctx(over: Partial<GreetingDecisionContext> = {}): GreetingDecisionContext {
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
    lastFullBriefingDate: '2026-06-29', // stale → briefing due
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
    ...over,
  };
}

// ---------------------------------------------------------------------------
// A. The briefing must survive a missing first name — the production case
// ---------------------------------------------------------------------------

describe('VTID-03646 A — the briefing no longer requires a first name', () => {
  afterEach(() => setNewdayOverviewRungEnabled(true));

  test('the guard passes with firstName null (prod: the prefetch never runs)', () => {
    expect(shouldAttemptNewdayOverview(ctx({ firstName: null }))).toBe(true);
  });

  test('the guard passes with a blank/whitespace name', () => {
    expect(shouldAttemptNewdayOverview(ctx({ firstName: '   ' }))).toBe(true);
  });

  test('the rung FIRES and speaks the briefing with no name available', () => {
    const d = computeGreetingDecision(ctx({ firstName: null, newdayOverview: payload() }));
    expect(d.wakeOpener).toBe('newday_overview');
    expect(d.register).toBe('daily_briefing');
    // The builder's own unknown-name branch, not a fabricated name.
    expect(d.directive).toContain('do not invent one');
    // The name LINE specifically must not leak a placeholder as the name
    // (the payload JSON below it has legitimate nulls of its own).
    expect(d.directive).toMatch(/User first name: \(unknown/);
    expect(d.directive).not.toMatch(/User first name: (null|undefined)/);
  });

  test('a name, when present, is still used', () => {
    const d = computeGreetingDecision(ctx({ firstName: 'Dragan', newdayOverview: payload() }));
    expect(d.wakeOpener).toBe('newday_overview');
    expect(d.directive).toContain('Dragan');
  });

  // The guards that DO still matter must not have been loosened along with it.
  test('still rejects an already-briefed day, onboarding, and first-time users', () => {
    expect(shouldAttemptNewdayOverview(ctx({ lastFullBriefingDate: '2026-06-30' }))).toBe(false);
    expect(shouldAttemptNewdayOverview(ctx({ greetingNeedsOnboarding: true }))).toBe(false);
    expect(shouldAttemptNewdayOverview(ctx({ greetingIsFirstTime: true }))).toBe(false);
    expect(shouldAttemptNewdayOverview(ctx({ hasUserId: false }))).toBe(false);
    expect(shouldAttemptNewdayOverview(ctx({ hasSupabase: false }))).toBe(false);
  });

  test('the kill switch still works — it is a fix, not a removal of the lever', () => {
    setNewdayOverviewRungEnabled(false);
    expect(shouldAttemptNewdayOverview(ctx({ firstName: null }))).toBe(false);
    expect(computeGreetingDecision(ctx({ firstName: null, newdayOverview: payload() })).wakeOpener)
      .not.toBe('newday_overview');
  });
});

// ---------------------------------------------------------------------------
// C. override_v2 must not dead-end after one announcement
// ---------------------------------------------------------------------------

describe('VTID-03646 C — override_v2 delivers, proposes, and asks', () => {
  const lead = 'Ich zeige dir die neuesten Nachrichten.';
  const spoken = (over: Partial<GreetingDecisionContext> = {}) =>
    computeGreetingDecision(
      ctx({
        lastFullBriefingDate: '2026-06-30', // not due → falls to rung 8
        openDecision: { mode: 'speak', source: 'wake:teacher', line: lead },
        wakeBriefDecisionId: 'wb-1',
        ...over,
      }),
    );

  test('the reported utterance is still the LEAD, and its facts are pinned', () => {
    const d = spoken();
    expect(d.wakeOpener).toBe('override_v2');
    expect(d.directive).toContain(lead);
  });

  test('it no longer forbids the follow-up question that ends the conversation', () => {
    const directive = spoken().directive ?? '';
    // The exact instructions that produced "announce, then listen".
    expect(directive).not.toMatch(/NO question after|KEINE Frage danach/i);
    expect(directive).not.toMatch(/ONE short utterance|NUR EINE kurze Aussage/i);
    expect(directive).not.toMatch(/Say exactly|Sage genau Folgendes/i);
  });

  test('it demands substance, one concrete next step, and a confirmation', () => {
    const directive = spoken().directive ?? '';
    expect(directive).toMatch(/SUBSTANCE/);
    expect(directive).toMatch(/NEXT STEP/);
    expect(directive).toMatch(/CONFIRMATION/);
    // Leading, not surveying — the "empty suggestion" half of the report.
    expect(directive).toMatch(/Never ask the user what they want to do/i);
    // The announce-without-delivering failure, named explicitly.
    expect(directive).toMatch(/Never announce an intention you then do not carry out/i);
  });

  test('the intent is language-neutral — no per-language sentence table survives', () => {
    // VTID-03644 shipped that table missing pt/pl. One English intent cannot
    // drift per locale, and every locale must get the same three beats.
    for (const lang of ['de', 'en', 'pt', 'pl', 'ar', 'zh', 'sr', 'ru', 'es', 'fr']) {
      const directive = spoken({ lang, greetLang: lang }).directive ?? '';
      expect(directive).toMatch(/SUBSTANCE/);
      expect(directive).toMatch(/CONFIRMATION/);
      expect(directive).toContain(lead);
    }
  });

  test("a guided-topic lesson is UNCHANGED — it is a script, not a lead", () => {
    const d = spoken({
      lang: 'de',
      greetLang: 'de',
      guidedTopicNarrationContent: 'Lektion: Atme langsam ein und aus.',
      openDecision: { mode: 'speak', source: 'wake:guided', line: 'Lektion: Atme langsam ein und aus.' },
    });
    expect(d.wakeOpener).toBe('override_v2');
    expect(d.directive).toContain('WÖRTLICH');
    expect(d.directive).not.toMatch(/NEXT STEP/);
  });

  test('a silent reconnect still outranks it and stays silent', () => {
    const d = computeGreetingDecision(
      ctx({
        lastFullBriefingDate: '2026-06-30',
        openDecision: { mode: 'silent', source: 'native_resume', line: null },
      }),
    );
    expect(d.wakeOpener).toBe('silent_reconnect');
    expect(d.directive).toBeNull();
  });
});
