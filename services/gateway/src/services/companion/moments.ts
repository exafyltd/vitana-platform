/**
 * VTID-05099 — companion "moments": which Vitana card to bring the member
 * today, and why. Each moment is a pure function of the member context; it
 * never reads the database and never writes text the member sees.
 *
 * A moment carries an ENGLISH intent for the composer (CLAUDE.md rule 41:
 * never a finished sentence Vitana says) and the card id from the Unified
 * Card System catalog (VTID-05085). The card's own title, text and button
 * come from that catalog on the client — never from here, never from the LLM.
 *
 * Phase 1: morning_greeting (F4 Talk to Vitana) and vitana_index (F2).
 * Phase 3 (VTID-05101): guided_journey_step (F1), diary_nudge (F3),
 * feature_tip (F8) and invite_friend (F7) — see COMPANION_MOMENTS.
 * New moments (and the future cards) are one more entry in that list.
 */
import type { VitanaIndexSnapshot } from '../user-context-profiler';
import { FEATURE_TIPS, type FeatureTip } from '../../data/feature-tips';
import { ENRICHMENT_CARD_TIPS } from '../../data/enrichment-card-tips';

export type CompanionTopic = 'health' | 'community' | 'business';

export interface MemberContext {
  userId: string;
  tenantId: string;
  firstName: string | null;
  locale: string;
  localDate: string;
  topics: Record<CompanionTopic, boolean>;
  vitanaIndex: VitanaIndexSnapshot | null;
  /** moment_key → most recent local date it was used (any mode). */
  lastUsed: Record<string, string>;
  // ── Phase 3 signals (VTID-05101). Optional: absent = no signal = the
  //    moment that needs it does not fire. Read in one batch per page.
  /** The member's Guided Journey state (user_guided_journey_state), null when none. */
  journey?: JourneySignal | null;
  /** UTC date of the member's latest diary_entries row inside the lookback, null when none. */
  diaryLastEntryDate?: string | null;
  /** Distinct active days (user_active_days) in the lookback window. */
  activeDays?: number | null;
  /** tip_key of feature tips already used inside the ledger lookback, newest first. */
  recentFeatureTips?: string[];
  /**
   * VTID-05367 (messenger-vitana-cards-v2): the enrichment cards (E1–E11) this
   * member should be offered, pre-computed in the tick loop with the real
   * `now` via `eligibleEnrichmentCards(completions, dismissRows, 'messenger',
   * now, unavailableEnrichmentCards())` — incomplete AND not cooling down AND
   * available. Moments read this set (membership check) and never call the
   * resolver or build a `Date` from `localDate`. Absent = no enrichment moment
   * fires (the enrichment lane adds the E-moments; VTID-05366).
   */
  eligibleEnrichmentCardTypes?: ReadonlySet<string>;
}

export interface JourneySignal {
  mode: 'guided' | 'full';
  onboardingStatus: string;
  /** Usage session the member is ON (the next episode), not a calendar day. */
  currentSession: number;
  /** True when the member already listened to an episode on their local today. */
  doneToday: boolean;
  lastOpenedTopicId: string | null;
  completedPracticeCount: number;
  qualificationThreshold: number;
}

export interface MomentCandidate {
  momentKey: string;
  /** Unified Card System id (VTID-05085 catalog). */
  cardType: string;
  /** null = always allowed (not tied to a member topic toggle). */
  topic: CompanionTopic | null;
  /** English description of what Vitana should say. Never the sentence itself. */
  intent: string;
  /** Only these facts may appear in the message (numbers, names). */
  facts: Record<string, unknown>;
  priority: number;
  /** Do not use the same moment again within this many days. */
  repeatAfterDays: number;
}

export interface Moment {
  key: string;
  build(ctx: MemberContext): MomentCandidate | null;
}

export const MORNING_GREETING_INTENT =
  'Warmly greet the member by first name, acknowledge the morning, remind them they can text you here or ' +
  'press the ORB to talk with you by voice, and offer one small helpful step for today.';

export const morningGreeting: Moment = {
  key: 'morning_greeting',
  build: () => ({
    momentKey: 'morning_greeting',
    cardType: 'F4',
    topic: null,
    intent: MORNING_GREETING_INTENT,
    facts: {},
    priority: 10,
    repeatAfterDays: 0,
  }),
};

export const VITANA_INDEX_INTENT =
  'Greet the member by first name for the morning. Share today\'s Vitana Index in one short sentence using ' +
  'the score and tier from the facts. Name the weakest pillar kindly and suggest one small, concrete action ' +
  'for it today. If the 7-day trend is positive, acknowledge the progress. Mention that the card below opens ' +
  'their Index.';

export const vitanaIndex: Moment = {
  key: 'vitana_index',
  build: (ctx) => {
    const ix = ctx.vitanaIndex;
    if (!ix || !Number.isFinite(ix.total)) return null;
    const trend = Number.isFinite(ix.trend_7d) ? ix.trend_7d : 0;
    return {
      momentKey: 'vitana_index',
      cardType: 'F2',
      topic: 'health',
      intent: VITANA_INDEX_INTENT,
      facts: {
        score: ix.total,
        tier: ix.tier,
        weakest_pillar: ix.weakest_pillar?.name ?? null,
        strongest_pillar: ix.strongest_pillar?.name ?? null,
        trend_7d: trend,
        points_to_really_good: ix.points_to_really_good,
      },
      // A visible move in either direction is more worth a morning message.
      priority: 50 + Math.min(20, Math.abs(trend)),
      repeatAfterDays: 3,
    };
  },
};

/** Phase 1 moments (kept as-is: the VTID-05099 contract tests iterate this list). */
export const MOMENTS: Moment[] = [morningGreeting, vitanaIndex];

// ── Phase 3 moments (VTID-05101) ────────────────────────────────────────────
// Priorities relative to Phase 1: greeting 10 (always-there fallback), Index
// 50–70. The journey step is the member's daily habit while they are in the
// guided journey (65, every other day); a lapsed diary sits below the Index
// (40–50); a feature tip (20) and the invite (15) only win on a quiet day.

const JOURNEY_INACTIVE_STATUSES = new Set(['skipped', 'completed']);

export const GUIDED_JOURNEY_STEP_INTENT =
  'Greet the member by first name for the morning. Encourage them, in one short and light sentence, to take ' +
  'today\'s next step of their Guided Journey, using the session number from the facts. If the facts show ' +
  'practice progress, acknowledge it briefly. Mention that the card below takes them straight to the next step.';

export const guidedJourneyStep: Moment = {
  key: 'guided_journey_step',
  build: (ctx) => {
    const j = ctx.journey;
    if (!j || j.mode !== 'guided' || JOURNEY_INACTIVE_STATUSES.has(j.onboardingStatus)) return null;
    if (j.doneToday || !Number.isInteger(j.currentSession) || j.currentSession < 1) return null;
    return {
      momentKey: 'guided_journey_step',
      cardType: 'F1',
      topic: 'health',
      intent: GUIDED_JOURNEY_STEP_INTENT,
      facts: {
        next_session: j.currentSession,
        onboarding_status: j.onboardingStatus,
        completed_practice_count: j.completedPracticeCount,
        qualification_threshold: j.qualificationThreshold,
        last_opened_topic_id: j.lastOpenedTopicId,
      },
      priority: 65,
      repeatAfterDays: 2,
    };
  },
};

/** Days without a diary entry before Vitana mentions it (and the window it looks back). */
export const DIARY_NUDGE_AFTER_DAYS = 3;
export const SIGNAL_LOOKBACK_DAYS = 30;

export const DIARY_NUDGE_INTENT =
  'Greet the member by first name for the morning. Kindly invite them to write a short diary entry today, ' +
  'noting without any reproach how many days it has been since their last entry (from the facts). Suggest one ' +
  'easy prompt to start with, such as how they slept or how they feel. Mention that the card below opens ' +
  'their diary.';

export const diaryNudge: Moment = {
  key: 'diary_nudge',
  build: (ctx) => {
    const last = ctx.diaryLastEntryDate;
    if (!last) return null; // never wrote inside the window: no habit to pick up again
    const days = daysBetween(last, ctx.localDate);
    if (!Number.isFinite(days) || days < DIARY_NUDGE_AFTER_DAYS || days > SIGNAL_LOOKBACK_DAYS) return null;
    return {
      momentKey: 'diary_nudge',
      cardType: 'F3',
      topic: 'health',
      intent: DIARY_NUDGE_INTENT,
      facts: { days_since_last_entry: days },
      priority: 40 + Math.min(10, days - DIARY_NUDGE_AFTER_DAYS),
      repeatAfterDays: 4,
    };
  },
};

/** The last this-many tips used are not repeated (the rest of the list rotates). */
export const FEATURE_TIP_ANTI_REPEAT = 6;

/** A feature tip only for members who actually use the app. */
export const FEATURE_TIP_MIN_ACTIVE_DAYS = 1;

export const FEATURE_TIP_INTENT =
  'Greet the member by first name for the morning. Introduce one Vitanaland feature they may not have tried ' +
  'yet, described by feature_name and feature_summary in the facts, in your own words and in one or two short ' +
  'sentences, and say why it could be useful for them. Mention that the card below opens it.';

/** Stable per-member starting point in the tip list, so members do not all get the same tip the same day. */
export function memberOffset(userId: string, n: number): number {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return n > 0 ? h % n : 0;
}

/** Tips the member evidently already uses, or that belong to a topic they switched off. */
function tipAlreadyCovered(tip: FeatureTip, ctx: MemberContext): boolean {
  if (tip.key === 'vitana-index') return !!ctx.vitanaIndex;
  if (tip.key === 'daily-diary') return !!ctx.diaryLastEntryDate;
  if (tip.key === 'my-business') return !ctx.topics.business;
  return false;
}

export function pickFeatureTip(ctx: MemberContext, tips: FeatureTip[] = FEATURE_TIPS): FeatureTip | null {
  const recent = new Set(ctx.recentFeatureTips ?? []);
  const start = memberOffset(ctx.userId, tips.length);
  for (let i = 0; i < tips.length; i++) {
    const tip = tips[(start + i) % tips.length];
    if (recent.has(tip.key) || tipAlreadyCovered(tip, ctx)) continue;
    return tip;
  }
  return null;
}

export const featureTip: Moment = {
  key: 'feature_tip',
  build: (ctx) => {
    if ((ctx.activeDays ?? 0) < FEATURE_TIP_MIN_ACTIVE_DAYS) return null;
    const tip = pickFeatureTip(ctx);
    if (!tip) return null;
    return {
      momentKey: 'feature_tip',
      cardType: 'F8',
      topic: 'community',
      intent: FEATURE_TIP_INTENT,
      // English source data for the model (it writes in the member's language);
      // the card's own label comes from the catalog, never from here.
      facts: { tip_key: tip.key, feature_name: tip.title.en, feature_summary: tip.description.en },
      priority: 20,
      repeatAfterDays: 5,
    };
  },
};

/** Only ask an engaged member to invite a friend. */
export const INVITE_MIN_ACTIVE_DAYS = 5;

export const INVITE_FRIEND_INTENT =
  'Greet the member by first name for the morning. Lightly suggest that they invite a friend or family member ' +
  'to join them in Vitanaland, because healthy habits are easier together. Keep it warm and without any ' +
  'pressure, and do not mention rewards or earnings. Mention that the card below lets them send an invitation.';

export const inviteFriend: Moment = {
  key: 'invite_friend',
  build: (ctx) => {
    const active = ctx.activeDays ?? 0;
    if (active < INVITE_MIN_ACTIVE_DAYS) return null;
    return {
      momentKey: 'invite_friend',
      cardType: 'F7',
      topic: 'community',
      intent: INVITE_FRIEND_INTENT,
      facts: { active_days_last_30: active },
      priority: 15,
      repeatAfterDays: 14,
    };
  },
};

// ── VTID-05366 (plan messenger-vitana-cards-v2): profile-enrichment moments ──
// One moment per enrichment card E1–E11. A moment fires ONLY when the tick has
// put the card in `ctx.eligibleEnrichmentCardTypes` — the member has not done
// it, has not dismissed it in the last 7 days, and its action works on this
// stack (E6/E7 need the Meta OAuth client). Moments never call the resolver and
// never build a Date (the tick computed the set with the real `now`).
//
// Priorities 39 → 29 sit BELOW every health/habit moment (diary_nudge 40–50,
// vitana_index 50–70, guided_journey_step 65) and ABOVE feature_tip (20) /
// invite_friend (15): a concrete setup step beats a generic tip on a quiet
// day, never a member's daily health card. This is the companion scale (higher
// wins) — NOT eligibleEnrichmentCards' 1-based catalog priority.

export const ENRICHMENT_MOMENT_INTENT =
  'Greet the member by first name for the morning. In one or two short, warm sentences, invite them to take ' +
  'one small step to complete their Vitanaland profile, described by card_title and card_description in the ' +
  'facts, in your own words and without any pressure, and say briefly how it helps them connect with the ' +
  'community. Mention that the card below takes them straight there.';

interface EnrichmentMomentSpec {
  card: 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6' | 'E7' | 'E8' | 'E9' | 'E10' | 'E11';
  topic: CompanionTopic | null;
  priority: number;
  repeatAfterDays: number;
}

/** Plan §2 table: topic, priority (29–39, card order) and repeat window per card. */
export const ENRICHMENT_MOMENT_SPECS: readonly EnrichmentMomentSpec[] = [
  { card: 'E1', topic: null, priority: 39, repeatAfterDays: 4 },
  { card: 'E2', topic: null, priority: 38, repeatAfterDays: 4 },
  { card: 'E3', topic: 'community', priority: 37, repeatAfterDays: 7 },
  { card: 'E4', topic: null, priority: 36, repeatAfterDays: 4 },
  { card: 'E5', topic: null, priority: 35, repeatAfterDays: 4 },
  { card: 'E6', topic: 'community', priority: 34, repeatAfterDays: 7 },
  { card: 'E7', topic: 'community', priority: 33, repeatAfterDays: 7 },
  { card: 'E8', topic: null, priority: 32, repeatAfterDays: 7 },
  { card: 'E9', topic: null, priority: 31, repeatAfterDays: 7 },
  { card: 'E10', topic: null, priority: 30, repeatAfterDays: 7 },
  { card: 'E11', topic: null, priority: 29, repeatAfterDays: 4 },
];

/** Stable moment key for an enrichment card (the ledger's moment_key). */
export const enrichmentMomentKey = (card: string): string => `enrichment_${card.toLowerCase()}`;

function enrichmentMoment(spec: EnrichmentMomentSpec): Moment {
  const key = enrichmentMomentKey(spec.card);
  return {
    key,
    build: (ctx) => {
      if (!ctx.eligibleEnrichmentCardTypes?.has(spec.card)) return null;
      const tip = ENRICHMENT_CARD_TIPS[spec.card];
      return {
        momentKey: key,
        cardType: spec.card,
        topic: spec.topic,
        intent: ENRICHMENT_MOMENT_INTENT,
        // English source data for the model (it writes in the member's
        // language); the card face itself comes from the catalog on the client.
        facts: { card_type: spec.card, card_title: tip.title.en, card_description: tip.description.en },
        priority: spec.priority,
        repeatAfterDays: spec.repeatAfterDays,
      };
    },
  };
}

/** The 11 enrichment moments, E1 → E11. */
export const ENRICHMENT_MOMENTS: Moment[] = ENRICHMENT_MOMENT_SPECS.map(enrichmentMoment);

/** Every moment the engine ranks (Phase 1 + Phase 3 + enrichment, VTID-05366). */
export const COMPANION_MOMENTS: Moment[] = [
  ...MOMENTS, guidedJourneyStep, diaryNudge, featureTip, inviteFriend, ...ENRICHMENT_MOMENTS,
];

const DAY_MS = 86_400_000;

export function daysBetween(fromDate: string, toDate: string): number {
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / DAY_MS);
}

/**
 * Pick ONE moment for today: topic toggles respected, recently used moments
 * skipped, highest priority wins, ties broken by key. Falls back to the
 * morning greeting so a member who opted in always hears from Vitana.
 */
export function pickMoment(ctx: MemberContext, moments: Moment[] = COMPANION_MOMENTS): MomentCandidate {
  const eligible: MomentCandidate[] = [];
  for (const m of moments) {
    const c = m.build(ctx);
    if (!c) continue;
    if (c.topic && !ctx.topics[c.topic]) continue;
    const last = ctx.lastUsed[c.momentKey];
    if (last && c.repeatAfterDays > 0 && daysBetween(last, ctx.localDate) < c.repeatAfterDays) continue;
    eligible.push(c);
  }
  eligible.sort((a, b) => b.priority - a.priority || a.momentKey.localeCompare(b.momentKey));
  return eligible[0] ?? (morningGreeting.build(ctx) as MomentCandidate);
}
