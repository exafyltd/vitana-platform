/**
 * Conversation Flow — `decideConversationFlow` byte-equality (roadmap Step 1b).
 *
 * The typed brain's FIRST commit delegates the opening decision to the Step-1a
 * `computeGreetingDecision`. This suite proves the delegation is LOSSLESS: for
 * every representative context, the `ConversationDecision` carries exactly the
 * observable decision `computeGreetingDecision` produced (opener kind, register,
 * NBA, directive, diag, effects) — zero behaviour change. If this ever diverges,
 * the brain has started deciding differently from the golden-characterized ladder.
 */

import {
  computeGreetingDecision,
  type GreetingDecisionContext,
} from '../../../src/services/conversation/compute-greeting-decision';
import {
  decideConversationFlow,
  type ConversationContext,
  type ConversationTransport,
} from '../../../src/services/conversation/decide-conversation-flow';
import type { OverviewPayload } from '../../../src/services/assistant-continuation/providers/new-day-overview-payload';

function richPayload(over: Partial<OverviewPayload> = {}): OverviewPayload {
  return {
    journey: null,
    vitana_index: {
      state: 'ok', today: 200, tier: 'Early', tier_framing: null, trend_7d: 0,
      weakest_pillar: { name: 'nutrition', score: 30 }, strongest_pillar: null,
      balance_label: 'balanced', pillars: null, projected_day_90: null, projected_day_90_tier: null,
    },
    life_compass: {
      state: 'set', primary_goal: 'longer life', category: null, target_date: null,
      target_value: null, target_unit: null, starting_value: null, set_at: null,
      days_to_deadline: null, goal_progress_pct: null,
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

function greetingCtx(over: Partial<GreetingDecisionContext> = {}): GreetingDecisionContext {
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
    ...over,
  };
}

function safeFast(over: Partial<GreetingDecisionContext> = {}): GreetingDecisionContext {
  return greetingCtx({ contextReadyResolved: false, safeFastGreetingLive: true, ...over });
}

// A context that reaches each of the 10 rungs, so the equivalence is exercised
// across the whole ladder, not just one branch.
const RUNG_CTXS: Array<{ label: string; ctx: GreetingDecisionContext }> = [
  { label: 'safe_fast_newday_overview', ctx: safeFast({ lastFullBriefingDate: '2026-06-29', newdayOverview: richPayload() }) },
  { label: 'safe_fast_first_time_welcome', ctx: safeFast({ hasPriorSession: false, greetingIsFirstTime: true, greetingNeedsOnboarding: true }) },
  { label: 'conv_resume', ctx: safeFast({ bucket: 'recent', resumeOverview: richPayload({ messages_unread: 2 }) }) },
  { label: 'safe_fast_proactive', ctx: safeFast({ bucket: 'same_day', resumeOverview: null, currentRoute: null, proactiveLine: 'Weiter mit deinem Schlaf?' }) },
  { label: 'safe_fast_newday', ctx: safeFast({ bucket: 'yesterday', resumeOverview: null }) },
  { label: 'safe_fast_pending_context', ctx: safeFast({ bucket: 'same_day', firstName: null, resumeOverview: null }) },
  { label: 'silent_reconnect', ctx: greetingCtx({ openDecision: { mode: 'silent', source: 'native_resume', line: null } }) },
  { label: 'override_v2', ctx: greetingCtx({ openDecision: { mode: 'speak', source: 'wake:teacher', line: 'Bleiben wir dran.' } }) },
  { label: 'silenced_on_cadence', ctx: greetingCtx({ voiceWakeBriefReason: 'recent_turn_continues_thread' }) },
  { label: 'legacy_default', ctx: greetingCtx({ bucket: 'reconnect' }) },
];

describe('decideConversationFlow — byte-equal delegation to computeGreetingDecision', () => {
  for (const transport of ['vertex', 'livekit', 'text'] as ConversationTransport[]) {
    for (const { label, ctx } of RUNG_CTXS) {
      test(`${transport} / ${label}: observable decision preserved`, () => {
        const g = computeGreetingDecision(ctx);
        const cc: ConversationContext = { transport, role: 'community', greeting: ctx };
        const d = decideConversationFlow(cc);

        expect(d.kind).toBe('opening');
        expect(d.transport).toBe(transport);
        expect(d.opener_kind).toBe(g.wakeOpener);
        expect(d.register).toBe(g.register ?? null);
        expect(d.nba).toEqual(g.nba ?? null);
        expect(d.directive).toBe(g.directive);
        expect(d.diag).toEqual(g.diag);
        expect(d.effects).toEqual(g.effects);
        expect(d.offer).toBeNull(); // Step 2 stub, unpopulated in 1b
      });
    }
  }

  test('transport + role are pass-through and do not alter the opening decision', () => {
    const ctx = safeFast({ bucket: 'recent', resumeOverview: richPayload() });
    const base = computeGreetingDecision(ctx);
    for (const transport of ['vertex', 'livekit', 'text'] as ConversationTransport[]) {
      for (const role of ['community', 'admin', 'developer', null]) {
        const d = decideConversationFlow({ transport, role, greeting: ctx });
        expect(d.opener_kind).toBe(base.wakeOpener);
        expect(d.directive).toBe(base.directive);
      }
    }
  });

  test('memory/social handles are carried but do not change the opening decision (1b)', () => {
    const ctx = safeFast({ bucket: 'recent', resumeOverview: richPayload() });
    const without = decideConversationFlow({ transport: 'vertex', role: null, greeting: ctx });
    const withHandles = decideConversationFlow({
      transport: 'vertex',
      role: null,
      greeting: ctx,
      // opaque handles — present but unread by the opening decision in Step 1b
      memory: { activeGoals: [], preferences: [], doNotRepeat: [] } as unknown as ConversationContext['memory'],
      social: { people: [], posts: [], events: [] } as unknown as ConversationContext['social'],
    });
    expect(withHandles).toEqual(without);
  });
});
