/**
 * Proactive Guide — Did-You-Know Tip Curriculum (BOOTSTRAP-DYK-TOUR)
 *
 * Vitana Index-centric curriculum for the 30-usage-day guided tour.
 * Every tip frames its feature in terms of the Index — the Index itself
 * is the first tip every new user hears; every subsequent tip connects
 * back to one of the canonical pillars (or tagged 'meta' for the Index
 * itself / Life Compass / ORB / Navigator).
 *
 * Gated on awareness.tenure.active_usage_days (not days_since_signup).
 * A user who signs up, returns a month later, and has two active-day
 * rows is on usage-day 2 — not day 31.
 *
 * Hard guardrail: active_usage_days > 30 → resolveNextTip() returns null.
 *
 * Plan: .claude/plans/proactive-did-you-generic-sifakis.md
 */

import type { UserAwareness } from './types';
import type { FeatureKey, FeatureIntroduction } from './feature-introductions';

export type IndexPillar =
  | 'Physical'
  | 'Mental'
  | 'Nutritional'
  | 'Social'
  | 'Environmental'
  | 'Prosperity';

export type TipPillarLink = IndexPillar | 'meta';

export interface DidYouKnowTip {
  /** Stable id — used as nudge_key for dismissal tracking. */
  tip_key: string;
  /** Maps into KNOWN_FEATURE_KEYS — governs the "only introduce once" rule. */
  feature_key: FeatureKey;
  /** Which Index pillar this tip lifts; 'meta' for the Index itself / LC / navigation. */
  index_pillar_link: TipPillarLink;
  /** Earliest active_usage_days at which this tip may fire (inclusive). */
  min_usage_day: number;
  /** Latest active_usage_days at which this tip may fire (inclusive). */
  max_usage_day: number;
  /** Optional gate: only fires if awareness.goal.category ∈ this list. */
  goal_categories?: string[];
  /** Base priority 0..100 — tiebreaker. Higher wins. */
  priority: number;
  /** ORB says this first: "Did you know … ?" */
  voice_opener: string;
  /** ORB then asks consent: "Want me to show you?" */
  voice_confirm: string;
  /** ORB says this AFTER the user lands on the target screen. Always mentions the pillar. */
  voice_on_nav: string;
  /** Silent-fallback card body. Always mentions Index or a pillar. */
  card_copy: string;
  /** Primary button label. */
  cta_label: string;
  /** Where to navigate on accept. Supports '?open=...' overlay-syntax like ORB. */
  cta_url: string;
  /** Optional custom eligibility check beyond the other gates. */
  eligibility_probe?: (a: UserAwareness) => boolean;
}

// =============================================================================
// Curriculum registry
// =============================================================================

/**
 * Hard-coded curriculum. Ordering within the array doesn't matter — resolver
 * sorts by priority. Tips are freely addable/removable; the snapshot test
 * ('dyk: every tip mentions Index or a pillar') enforces the framing rule.
 *
 * Priority conventions:
 *   100 → foundational (Index itself, Life Compass)
 *   90  → direct Index views (Index Detail, Health section)
 *   80  → Index-movers (Autopilot, My Journey)
 *   70  → pillar-specific domain entries (Calendar, Memory Garden)
 *   60  → secondary domains (Community, Business Hub, Navigator)
 *   50  → dismissal phrases + misc
 */
export const DYK_TIP_REGISTRY: DidYouKnowTip[] = [
  // ─── Usage day 0: The Index is everything ───────────────────────────────
  {
    tip_key: 'dyk_vitana_index_day0',
    feature_key: 'vitana_index',
    index_pillar_link: 'meta',
    min_usage_day: 0,
    max_usage_day: 30,
    priority: 100,
    voice_opener:
      'Did you know that your Vitana Index is a single number — zero to 999 — that measures your quality of life across five pillars?',
    voice_confirm: 'Want me to show you how it works?',
    voice_on_nav:
      "Here it is. Your Index is built from Physical, Mental, Nutritional, Social, and Environmental — five pillars, each scored live. The number moves as you do.",
    card_copy:
      'Your Vitana Index is one number across five pillars — Physical, Mental, Nutritional, Social, Environmental. Want to see it?',
    cta_label: 'Show me my Index',
    cta_url: '/health/vitana-index',
  },
  {
    tip_key: 'dyk_voice_chat_basics_day0',
    feature_key: 'voice_chat_basics',
    index_pillar_link: 'meta',
    min_usage_day: 0,
    max_usage_day: 30,
    priority: 95,
    voice_opener:
      'Did you know you can talk to me any time — just tap the orb — and I can answer questions about your Index, your goals, or just keep you company?',
    voice_confirm: 'Want me to walk you through it?',
    voice_on_nav:
      "That's the orb. Tap to talk, tap again to stop. I remember what you tell me so your Index advice gets smarter over time.",
    card_copy:
      "Tap the orb any time to talk. I remember what you share and use it to guide your Vitana Index over time.",
    cta_label: 'Got it',
    cta_url: '/home',
  },

  // ─── Usage day 1: Compass + deeper Index ────────────────────────────────
  {
    tip_key: 'dyk_life_compass_day1',
    feature_key: 'life_compass',
    index_pillar_link: 'meta',
    min_usage_day: 1,
    max_usage_day: 30,
    priority: 100,
    voice_opener:
      "Did you know you have a Life Compass goal set — I seeded the default longevity goal for you — and that goal actually re-weights how your Vitana Index is scored?",
    voice_confirm: 'Want to see it and maybe pick your own?',
    voice_on_nav:
      "This is Life Compass. Change the goal and your Index re-weights — a career goal boosts Prosperity's weight, a health goal boosts Physical. Pick the one that matches where you are.",
    card_copy:
      'Your Life Compass goal re-weights every pillar of your Vitana Index. I set a default — you can change it any time.',
    cta_label: 'Open Life Compass',
    cta_url: '/memory?open=life_compass',
    eligibility_probe: (a) => !!a.goal?.is_system_seeded,
  },
  {
    tip_key: 'dyk_vitana_index_detail_day1',
    feature_key: 'vitana_index_detail',
    index_pillar_link: 'meta',
    min_usage_day: 1,
    max_usage_day: 30,
    priority: 90,
    voice_opener:
      'Did you know you can tap your Index badge any time to see the breakdown — which pillar is strongest, which is dragging, what moved yesterday?',
    voice_confirm: 'Want me to open the detail view?',
    voice_on_nav:
      "This is your Index Detail. Each bar is one pillar — the short one is your weakest, and that's usually the biggest lever. Tap a bar to see what feeds it.",
    card_copy:
      "Tap your Index badge any time for the full pillar breakdown — your weakest pillar is where the next bump comes from.",
    cta_label: 'Open Index Detail',
    cta_url: '/health/vitana-index',
  },

  // ─── Usage day 2: Health (Physical pillar) ──────────────────────────────
  {
    tip_key: 'dyk_health_section_day2',
    feature_key: 'health_section',
    index_pillar_link: 'Physical',
    min_usage_day: 2,
    max_usage_day: 30,
    priority: 90,
    voice_opener:
      'Did you know that everything you log in Health — sleep, movement, nutrition — feeds directly into the Physical pillar of your Vitana Index?',
    voice_confirm: 'Want me to show you the Health section?',
    voice_on_nav:
      "Here's Health. Every entry — a walk, a meal, a sleep log — lifts your Physical pillar, and the Physical pillar is the biggest single lever on your Vitana Index.",
    card_copy:
      'Sleep, movement, nutrition — everything you log in Health lifts your Physical pillar of the Vitana Index.',
    cta_label: 'Open Health',
    cta_url: '/health',
  },

  // ─── Usage day 3: Index-movers (Autopilot + My Journey) ────────────────
  {
    tip_key: 'dyk_autopilot_index_impact_day3',
    feature_key: 'autopilot_index_impact',
    index_pillar_link: 'meta',
    min_usage_day: 3,
    max_usage_day: 30,
    priority: 85,
    voice_opener:
      "Did you know the Autopilot actions I recommend are picked because they're the shortest path to lifting a specific pillar on your Vitana Index?",
    voice_confirm: 'Want to see how they connect to your Index?',
    voice_on_nav:
      "Here's Autopilot. Every card shows the pillar it targets and the estimated Index bump — you're not guessing what matters, I am.",
    card_copy:
      "Every Autopilot action is scored by how much it lifts a pillar of your Vitana Index. Want to see today's?",
    cta_label: 'Open Autopilot',
    cta_url: '/autopilot',
    eligibility_probe: (a) => a.recent_activity.open_autopilot_recs >= 1,
  },
  {
    tip_key: 'dyk_my_journey_day3',
    feature_key: 'my_journey',
    index_pillar_link: 'meta',
    min_usage_day: 3,
    max_usage_day: 30,
    priority: 80,
    voice_opener:
      'Did you know you have a 90-day Journey laid out, and you can watch your Vitana Index trajectory overlaid on the waves?',
    voice_confirm: 'Want me to show you My Journey?',
    voice_on_nav:
      "This is My Journey. The colored waves are the six phases of the 90-day plan; the line overlay is your Vitana Index projection. You can see the shape of where you're heading.",
    card_copy:
      'Your 90-day Journey shows your Vitana Index trajectory overlaid on six waves. See where you are.',
    cta_label: 'Open My Journey',
    cta_url: '/autopilot',
    eligibility_probe: (a) => !!a.journey.current_wave,
  },

  // ─── Usage day 5: Calendar (Physical + Nutritional) ────────────────────
  {
    tip_key: 'dyk_calendar_index_impact_day5',
    feature_key: 'calendar_index_impact',
    index_pillar_link: 'Physical',
    min_usage_day: 5,
    max_usage_day: 30,
    priority: 75,
    voice_opener:
      'Did you know every event you complete in your Calendar is scored by the pillar it touches — a 30-minute walk lifts Physical, a meditation slot lifts Mental — and your Vitana Index updates within the hour?',
    voice_confirm: "Want to see today's Calendar?",
    voice_on_nav:
      'This is your Calendar. Each completed event pushes its matched pillar up — the Index recomputes automatically. Show up, score up.',
    card_copy:
      'Every completed Calendar event lifts its matched pillar — walk = Physical, meditation = Mental. Your Vitana Index recomputes automatically.',
    cta_label: 'Open Calendar',
    cta_url: '/autopilot?tab=calendar',
    eligibility_probe: (a) =>
      a.recent_activity.overdue_calendar_count + a.recent_activity.upcoming_calendar_24h_count === 0,
  },

  // ─── Usage day 7: Memory Garden (Mental pillar) ────────────────────────
  {
    tip_key: 'dyk_memory_garden_day7',
    feature_key: 'memory_garden',
    index_pillar_link: 'Mental',
    min_usage_day: 7,
    max_usage_day: 30,
    priority: 70,
    voice_opener:
      "Did you know Memory Garden holds everything I've learned about you — your goals, values, what you care about — and that context is what keeps your Mental pillar honest?",
    voice_confirm: 'Want me to open it?',
    voice_on_nav:
      "This is your Memory Garden. Anything you share with me lives here — you can edit or delete anything. It's what lets me guide your Mental pillar without being generic.",
    card_copy:
      "Memory Garden holds what I know about you. It's the fuel for your Mental pillar on the Vitana Index — and you control it.",
    cta_label: 'Open Memory Garden',
    cta_url: '/memory',
  },

  // ─── Usage day 10: Community (Social pillar) ───────────────────────────
  {
    tip_key: 'dyk_community_day10',
    feature_key: 'community',
    index_pillar_link: 'Social',
    min_usage_day: 10,
    max_usage_day: 30,
    priority: 65,
    voice_opener:
      "Did you know the Social pillar of your Vitana Index doesn't move until you have real connections — and Community is where you find them?",
    voice_confirm: 'Want me to show you?',
    voice_on_nav:
      'Community. Every connection you build lifts your Social pillar — and the Social pillar is historically one of the strongest longevity predictors there is.',
    card_copy:
      "Your Social pillar can't move without connections. Community is where they happen.",
    cta_label: 'Open Community',
    cta_url: '/community',
    eligibility_probe: (a) => a.community_signals.connection_count === 0,
  },

  // ─── Usage day 14: Business Hub (Prosperity pillar) + Navigator ────────
  {
    tip_key: 'dyk_business_hub_day14',
    feature_key: 'business_hub',
    index_pillar_link: 'Prosperity',
    min_usage_day: 14,
    max_usage_day: 30,
    goal_categories: ['career', 'financial_freedom', 'Advance Career', 'Build Financial Freedom'],
    priority: 70,
    voice_opener:
      "Did you know Business Hub feeds the Prosperity pillar of your Vitana Index? Your career moves and financial decisions are scored too, not just your sleep.",
    voice_confirm: 'Want me to open Business Hub?',
    voice_on_nav:
      'Business Hub. Every deal, every skill milestone, every financial decision lifts the Prosperity pillar. Longevity is not only biology.',
    card_copy:
      'Business Hub lifts the Prosperity pillar of your Vitana Index — career and finance matter to longevity too.',
    cta_label: 'Open Business Hub',
    cta_url: '/business',
  },
  {
    tip_key: 'dyk_navigator_day14',
    feature_key: 'navigator',
    index_pillar_link: 'meta',
    min_usage_day: 14,
    max_usage_day: 30,
    priority: 60,
    voice_opener:
      'Did you know you can ask me to take you anywhere in Vitana by voice — "show me my Index", "open Calendar", "take me to Memory" — and I will jump you there?',
    voice_confirm: 'Want to try it?',
    voice_on_nav:
      "That's Navigator. Any screen, any time, just ask — including your Vitana Index and any pillar detail view. Fastest way around.",
    card_copy:
      "Ask me to open any screen by voice — your Index, Calendar, Memory, anything. That's Navigator.",
    cta_label: 'Got it',
    cta_url: '/home',
  },

  // ─── Usage day 20: Dismissal phrases ────────────────────────────────────
  {
    tip_key: 'dyk_dismissal_phrases_day20',
    feature_key: 'dismissal_phrases',
    index_pillar_link: 'meta',
    min_usage_day: 20,
    max_usage_day: 30,
    priority: 55,
    voice_opener:
      'Did you know you can tell me "quiet" or "not today" any time, and I will stop nudging you — even about your Vitana Index — until you come back?',
    voice_confirm: 'Want me to explain the phrases?',
    voice_on_nav:
      '"Quiet" or "give me space" pauses me until tomorrow 6 AM. "Not this week" pauses longer. "Skip it" silences one Index nudge only. You are always in charge.',
    card_copy:
      'Say "quiet", "not today", or "skip it" any time to pause all Index nudges — you control the pacing.',
    cta_label: 'Got it',
    cta_url: '/home',
  },
];

// =============================================================================
// Resolver
// =============================================================================

export interface ResolveOptions {
  /**
   * If provided, tips already in this list are excluded. Defaults to
   * awareness.feature_introductions (populated from user_feature_introductions).
   */
  introduced_feature_keys?: string[];
}

/**
 * Pick the next Did-You-Know tip for a user, or null if none eligible.
 * Applies, in order:
 *   1. Hard guardrail: active_usage_days > 30 → null.
 *   2. Usage-day window: [min_usage_day, max_usage_day] must contain current day.
 *   3. Already-introduced filter.
 *   4. Goal-category gate (if tip specifies one).
 *   5. Custom eligibility_probe (if provided).
 *   6. Tie-break: priority desc, with +20 boost for Index-meta tips.
 */
export function resolveNextTip(
  awareness: UserAwareness,
  options: ResolveOptions = {},
): DidYouKnowTip | null {
  const usageDays = awareness.tenure.active_usage_days ?? 0;

  // 1. Hard 30-usage-day guardrail
  if (usageDays > 30) return null;

  const introduced = new Set(
    options.introduced_feature_keys ?? awareness.feature_introductions ?? [],
  );

  const eligible = DYK_TIP_REGISTRY.filter((tip) => {
    // 2. Usage-day window
    if (usageDays < tip.min_usage_day || usageDays > tip.max_usage_day) return false;
    // 3. Already introduced?
    if (introduced.has(tip.feature_key)) return false;
    // 4. Goal-category gate
    if (tip.goal_categories && tip.goal_categories.length > 0) {
      const cat = awareness.goal?.category;
      if (!cat || !tip.goal_categories.includes(cat)) return false;
    }
    // 5. Custom probe
    if (tip.eligibility_probe) {
      try {
        if (!tip.eligibility_probe(awareness)) return false;
      } catch {
        // Probe error → skip tip, don't crash resolver
        return false;
      }
    }
    return true;
  });

  if (eligible.length === 0) return null;

  // 6. Priority tiebreaker with Index-meta boost
  const scored = eligible
    .map((tip) => ({ tip, score: tip.priority + (tip.index_pillar_link === 'meta' ? 20 : 0) }))
    .sort((a, b) => b.score - a.score);

  return scored[0].tip;
}

/**
 * Lookup helper — used by the POST accept/decline route and by the ORB
 * tool-dispatch path to re-hydrate a tip object from its key.
 */
export function getTipByKey(tipKey: string): DidYouKnowTip | null {
  return DYK_TIP_REGISTRY.find((t) => t.tip_key === tipKey) ?? null;
}

/**
 * Convenience for the ORB live route — build a compact hint object that fits
 * the existing tour_hint contract (keeps the system-instruction block small).
 */
export function tourHintFromTip(tip: DidYouKnowTip): {
  tip_key: string;
  feature_key: string;
  voice_opener: string;
  voice_confirm: string;
  voice_on_nav: string;
  cta_url: string;
  index_pillar_link: TipPillarLink;
} {
  return {
    tip_key: tip.tip_key,
    feature_key: tip.feature_key as string,
    voice_opener: tip.voice_opener,
    voice_confirm: tip.voice_confirm,
    voice_on_nav: tip.voice_on_nav,
    cta_url: tip.cta_url,
    index_pillar_link: tip.index_pillar_link,
  };
}

/**
 * Accepted pillar / Index reference words — snapshot test helper. If a
 * test needs to verify that every tip's copy mentions the Index or a pillar,
 * it can pass each string through this check.
 */
export const INDEX_FRAMING_TOKENS: readonly string[] = [
  'Index',
  'Physical',
  'Mental',
  'Nutritional',
  'Social',
  'Environmental',
  'Prosperity',
];

export function mentionsIndexOrPillar(text: string): boolean {
  return INDEX_FRAMING_TOKENS.some((tok) => text.includes(tok));
}
