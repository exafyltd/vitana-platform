/**
 * VTID-04864 — the VTNA reward rules. ONE table, read by every payer and by
 * the Wallet → Rewards screen, so what members are promised and what the
 * system pays can never drift apart again.
 *
 * Owner decision 2026-10-03 — one sentence a member can remember:
 *   "You earn VTNA for real things you do yourself, once per milestone,
 *    and for staying consistent."
 *
 *   1. First steps   — fixed amount, once each.
 *   2. Habits        — streak milestones only (3 / 7 / 30 days), once each.
 *   3. Community     — when OTHERS respond: 1,000 per friend you invited who
 *                      joins (10 per 30 days) + 10,000 once at 10 friends.
 *   4. Never earns   — anything Vitana does for you (incl. Vitana-drafted
 *                      posts), buying credits, self-reported actions.
 *
 * Owner decision 2026-10-05 (VTID-04878) amends it with three repeatable,
 * capped rules, paid through claim_capped_reward() with the key
 * `<rule>:<ref>` (capRewardKey) so a cap holds under concurrent claims:
 *   - autopilot_action_done  5 VTNA, max 2 per UTC day (Autopilot completion
 *     pays again — small and capped, because completion is self-reported);
 *   - live_room_15min       20 VTNA, max 3 per ISO week (server-verified join
 *     and leave, 15 full minutes, with someone else in the room);
 *   - index_new_best        50 VTNA, max 1 per ISO week (a new Vitana Index
 *     personal best at least 10 points above the previous one).
 *
 * 1 VTNA = EUR 0.01 (VTID-04809). Every payout goes through credit_wallet()
 * with p_type 'reward' and the idempotency key from rewardEventId(), so a
 * reward lands at most once per member however many code paths notice it.
 *
 * Only rules with `live: true` are shown to members. A rule that nothing
 * pays yet must never appear on the screen — promising rewards that never
 * arrive is the exact problem this table exists to end.
 */

export type RewardRuleGroup = 'first_steps' | 'habits' | 'community';
export type CapWindow = 'day' | 'week';

export interface RewardRule {
  /** Stable id; also the milestone id for first steps and habits. */
  id: string;
  group: RewardRuleGroup;
  /** VTNA paid when the rule is met. */
  amount: number;
  /** Paid at most once per member (first steps, habits) or capped per period. */
  once: boolean;
  /** Cap for repeatable rules, e.g. 10 per 30 days. */
  cap?: { count: number; days: number };
  /**
   * VTID-04878: calendar window (UTC) for a cap enforced by
   * claim_capped_reward(); rules without it use a rolling `cap.days` window.
   */
  window?: CapWindow;
  /** False = defined but not paid by anything yet → never shown. */
  live: boolean;
}

export const VTNA_REWARD_RULES: ReadonlyArray<RewardRule> = [
  // 1. First steps — once each
  { id: 'onboarding_complete',  group: 'first_steps', amount: 50, once: true, live: true },
  { id: 'profile_complete',     group: 'first_steps', amount: 20, once: true, live: true },
  { id: 'first_diary',          group: 'first_steps', amount: 15, once: true, live: true },
  { id: 'first_group',          group: 'first_steps', amount: 15, once: true, live: true },
  { id: 'first_event_rsvp',     group: 'first_steps', amount: 15, once: true, live: true },
  { id: 'first_connection',     group: 'first_steps', amount: 20, once: true, live: true },
  { id: 'five_connections',     group: 'first_steps', amount: 30, once: true, live: true },
  { id: 'first_match_accepted', group: 'first_steps', amount: 20, once: true, live: true },
  { id: 'first_health_check',   group: 'first_steps', amount: 25, once: true, live: true },

  // 2. Habits — streak milestones only, once each
  { id: 'diary_streak_3',  group: 'habits', amount: 20,  once: true, live: true },
  { id: 'diary_streak_7',  group: 'habits', amount: 50,  once: true, live: true },
  { id: 'diary_streak_30', group: 'habits', amount: 100, once: true, live: true },
  // VTID-04878 (owner decision 2026-10-05) — repeatable, capped.
  {
    id: 'autopilot_action_done', group: 'habits', amount: 5, once: false,
    cap: { count: 2, days: 1 }, window: 'day',
    // Paid by routes/autopilot-recommendations.ts and calendar-producers.ts.
    live: true,
  },
  {
    id: 'index_new_best', group: 'habits', amount: 50, once: false,
    cap: { count: 1, days: 7 }, window: 'week',
    // Paid by services/rewards/reward-sweep.ts.
    live: true,
  },

  // 3. Community — when others respond, capped
  // Owner decision 2026-10-03: inviting must be worth it — 1,000 VTNA per
  // friend who joins, and a one-time 10,000 VTNA bonus at 10 friends.
  {
    id: 'invite_friend_joined', group: 'community', amount: 1000, once: false,
    cap: { count: 10, days: 30 },
    // Paid by community-autopilot/invites.ts, which is switched on by
    // COMMUNITY_INVITE_REWARD_ENABLED (on unless exactly 'false').
    live: true,
  },
  {
    id: 'live_room_15min', group: 'community', amount: 20, once: false,
    cap: { count: 3, days: 7 }, window: 'week',
    // Paid by services/rewards/reward-sweep.ts.
    live: true,
  },
  {
    id: 'invited_friends_10', group: 'community', amount: 10000, once: true,
    // Paid by invites.ts when the 10th invited friend's reward lands.
    live: true,
  },
];

/** Invited friends (rewarded) needed for the invited_friends_10 bonus. */
export const INVITE_MILESTONE_FRIENDS = 10;

/** What never earns VTNA — shown on the screen so the rules are complete. */
export const VTNA_NEVER_EARNS: ReadonlyArray<string> = [
  'done_by_vitana',     // anything Vitana does or drafts for you
  'purchases',          // buying credits or bonus packs
  'self_reported',      // actions the system cannot verify
];

const BY_ID = new Map(VTNA_REWARD_RULES.map((r) => [r.id, r]));

export function getRewardRule(id: string): RewardRule | undefined {
  return BY_ID.get(id);
}

/** Amount for a rule, or 0 when the id is not a reward rule. */
export function rewardAmount(id: string): number {
  return BY_ID.get(id)?.amount ?? 0;
}

/**
 * The one idempotency key per (rule, member) for once-only rules. Every
 * payer of the same rule MUST use it, so a second path lands as a
 * credit_wallet duplicate instead of a second payout. The format is the
 * one milestone-service has always used, so rewards already paid keep
 * counting as paid.
 */
export function rewardEventId(ruleId: string, userId: string): string {
  return `milestone_${ruleId}_${userId}`;
}

/** VTID-04878: the idempotency key of one occurrence of a capped rule. */
export function capRewardKey(ruleId: string, ref: string): string {
  return `${ruleId}:${ref}`;
}

/** The capped rules paid through claim_capped_reward(). */
export function cappedRules(): RewardRule[] {
  return VTNA_REWARD_RULES.filter((r) => !!r.window && !!r.cap);
}

/** Start (UTC) of the calendar window a capped claim counts against. */
export function capWindowStart(window: CapWindow, now: Date = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (window === 'week') {
    // ISO week: Monday 00:00 UTC (Postgres date_trunc('week', ...)).
    const dow = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dow);
  }
  return d;
}

/**
 * Whether a rule actually pays in this process right now. Wallet → Rewards
 * lists exactly these rules (visibleRewardRules), so a switched-off reward is
 * never advertised. Three independent switches (VTID-04899):
 *  - invite rules: COMMUNITY_INVITE_REWARD_ENABLED, on unless exactly 'false';
 *  - autopilot_action_done (paid at completion): AUTOPILOT_ACTION_REWARD_ENABLED,
 *    fail closed — pays only when exactly 'true' (owner decision 2026-10-05;
 *    production pins 'false', staging 'true');
 *  - live_room_15min and index_new_best: REWARD_SWEEP_ENABLED, on unless
 *    exactly 'false'. Deliberate coupling: the sweep is their only payer, so
 *    the sweep switch decides both payout and visibility. If the sweep is ever
 *    split (e.g. milestones only), these two rules get their own switch.
 */
export function isRuleLive(rule: RewardRule, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!rule.live) return false;
  if (rule.id === 'invite_friend_joined' || rule.id === 'invited_friends_10') {
    return env.COMMUNITY_INVITE_REWARD_ENABLED !== 'false';
  }
  if (rule.id === 'autopilot_action_done') {
    return env.AUTOPILOT_ACTION_REWARD_ENABLED === 'true';
  }
  if (rule.id === 'live_room_15min' || rule.id === 'index_new_best') {
    return env.REWARD_SWEEP_ENABLED !== 'false';
  }
  return true;
}

/** The rules a member sees: live ones only, in display order. */
export function visibleRewardRules(env: NodeJS.ProcessEnv = process.env): RewardRule[] {
  return VTNA_REWARD_RULES.filter((r) => isRuleLive(r, env));
}
