/**
 * VTID-05143 (builds VTID-05085 Phase 1) — Unified Card System catalog.
 *
 * The single server-side source of
 *   - which enrichment cards exist (E1–E11) and their static priority
 *     (plan §3.5: E1 → E2 → E3 → E6 → E7 → E8 → E9 → E4 → E5 → E10 → E11),
 *   - which screen shows which enrichment cards (plan §2A / §4),
 *   - the eligibility rule (incomplete AND not cooling down) shared by
 *     GET /api/v1/enrichment-cards and, later, the Messenger companion engine
 *     (VTID-05099), so a card done or dismissed anywhere disappears everywhere.
 *
 * Plan of record: docs/validation/VTID-05085/plan-sparring.md
 * (hash e7abbebb1e777f3aa27eea0356a5ca697328ee180c32a24e04150e2f5a238ab7).
 *
 * Boost cards G1–G3 (Phase 3, plan §2C / §6.5): which screen shows which
 * boost card, their urgency order (G3 → G2 → G1) and the same eligibility
 * rule (trigger fired AND not cooling down, same `user_enrichment_cards`
 * 7-day cooldown). G4 is out of scope (owner decision). Feature cards
 * (F1–F11) are a static per-screen list in the frontend and are not served
 * from this catalog. Pure module: no I/O, no clock reads.
 */

export const ENRICHMENT_CARD_TYPES = [
  'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9', 'E10', 'E11',
] as const;
export type EnrichmentCardType = (typeof ENRICHMENT_CARD_TYPES)[number];

/** Boost cards with a trigger in scope (Phase 3). G4 stays deferred (plan §2C). */
export const BOOST_CARD_TYPES = ['G1', 'G2', 'G3'] as const;
export type BoostCardType = (typeof BOOST_CARD_TYPES)[number];

export type CardCategory = 'enrichment' | 'boost';

/** Every card the dismiss endpoint accepts: E1–E11 and the boost cards in scope. */
export type DismissibleCardType = EnrichmentCardType | BoostCardType;

/** Static priority (plan §3.5). Index 0 = shown first. */
export const ENRICHMENT_PRIORITY: readonly EnrichmentCardType[] = [
  'E1', 'E2', 'E3', 'E6', 'E7', 'E8', 'E9', 'E4', 'E5', 'E10', 'E11',
];

/**
 * Screens the card system knows. `messenger` (owner 2026-10-13, VTID-05099)
 * and `calendar` are included from Phase 1 so News Feed/Home, Messenger and
 * Calendar can integrate at the same time.
 */
export const CARD_SCREENS = [
  'home',
  'profile',
  'longevity-journey',
  'calendar',
  'vitana-index',
  'autopilot',
  'community',
  'make-a-post',
  'talk-to-vitana',
  'messenger',
] as const;
export type CardScreen = (typeof CARD_SCREENS)[number];

const ALL_ENRICHMENT: readonly EnrichmentCardType[] = ENRICHMENT_CARD_TYPES;

/**
 * Screen → enrichment cards (plan §2A "Screens" column and §4).
 *   - profile: only the cards that enrich the profile itself — E1–E7, E11
 *     (VTID-05211, owner 2026-10-15). Connectors (E8, E9) and notifications
 *     (E10) are not profile content; the frontend `CARD_SCREENS.profile.allow`
 *     carries the same list (VTID-05210).
 *   - calendar: E8 only (plan §4 Calendar: "Enrichment: E8").
 *   - messenger: E1–E11 (VTID-05099: the companion engine picks one).
 *   - vitana-index, talk-to-vitana: no enrichment cards in the plan.
 */
export const SCREEN_ENRICHMENT_CARDS: Readonly<Record<CardScreen, readonly EnrichmentCardType[]>> = {
  home: ALL_ENRICHMENT,
  profile: ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E11'],
  'longevity-journey': ['E4', 'E5'],
  calendar: ['E8'],
  'vitana-index': [],
  autopilot: ['E10'],
  community: ['E3', 'E6', 'E7'],
  'make-a-post': ['E3'],
  'talk-to-vitana': [],
  messenger: ALL_ENRICHMENT,
};

/**
 * Boost urgency (plan §3.5 "Boost cards — trigger urgency"): G3 streak at
 * risk (time-sensitive) → G2 unread matches (social) → G1 profile completion
 * (persistent). Index 0 = shown first; boost cards follow enrichment cards.
 */
export const BOOST_PRIORITY: readonly BoostCardType[] = ['G3', 'G2', 'G1'];

/**
 * Screen → boost cards (plan §2C "Screens" column and §4):
 *   G1 Complete Your Profile → home, profile
 *   G2 Unread Matches        → home
 *   G3 Streak at Risk        → home, longevity-journey, vitana-index, autopilot
 * `autopilot` is the key the My Journey screen (/autopilot) sends, so G3's
 * Longevity Journey placement reaches it. Every other screen (incl.
 * messenger) shows no boost card.
 */
export const SCREEN_BOOST_CARDS: Readonly<Record<CardScreen, readonly BoostCardType[]>> = {
  home: ['G1', 'G2', 'G3'],
  profile: ['G1'],
  'longevity-journey': ['G3'],
  calendar: [],
  'vitana-index': ['G3'],
  autopilot: ['G3'],
  community: [],
  'make-a-post': [],
  'talk-to-vitana': [],
  messenger: [],
};

/** G1 fires below this weighted profile completion (plan §2C: `< 80`). */
export const PROFILE_COMPLETION_BOOST_THRESHOLD = 80;
/** G3 fires when the streak that ended the day before yesterday is longer than this (plan §2C: `> 3`). */
export const STREAK_AT_RISK_MIN_EXCLUSIVE = 3;

/** What each boost trigger computed — `data` is returned to the frontend on the card. */
export type BoostTrigger =
  | { card_type: 'G1'; fired: boolean; data: { completion_pct: number } }
  | { card_type: 'G2'; fired: boolean; data: { unread_match_count: number } }
  | { card_type: 'G3'; fired: boolean; data: { streak_days: number } };

export type BoostTriggers = ReadonlyMap<BoostCardType, BoostTrigger>;

export const DEFAULT_COOLDOWN_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export function isCardScreen(value: unknown): value is CardScreen {
  return typeof value === 'string' && (CARD_SCREENS as readonly string[]).includes(value);
}

export function isEnrichmentCardType(value: unknown): value is EnrichmentCardType {
  return typeof value === 'string' && (ENRICHMENT_CARD_TYPES as readonly string[]).includes(value);
}

export function isBoostCardType(value: unknown): value is BoostCardType {
  return typeof value === 'string' && (BOOST_CARD_TYPES as readonly string[]).includes(value);
}

/** E1–E11 and G1–G3 can be dismissed (G4 is out of scope and stays 400). */
export function isDismissibleCardType(value: unknown): value is DismissibleCardType {
  return isEnrichmentCardType(value) || isBoostCardType(value);
}

/** 1-based urgency of a boost card within the boost category (1 = most urgent). */
export function boostPriority(cardType: BoostCardType): number {
  return BOOST_PRIORITY.indexOf(cardType) + 1;
}

/** 1-based static priority of an enrichment card (1 = most valuable). */
export function enrichmentPriority(cardType: EnrichmentCardType): number {
  return ENRICHMENT_PRIORITY.indexOf(cardType) + 1;
}

/** One row of `user_enrichment_cards` as the gateway reads it. */
export interface EnrichmentDismissRow {
  card_type: string;
  dismissed_at: string | null;
  cooldown_days: number | null;
}

/** When a dismissal stops hiding the card, or null if it never hid it. */
export function dismissedUntil(row: Pick<EnrichmentDismissRow, 'dismissed_at' | 'cooldown_days'>): Date | null {
  if (!row.dismissed_at) return null;
  const at = new Date(row.dismissed_at).getTime();
  if (Number.isNaN(at)) return null;
  const days = typeof row.cooldown_days === 'number' && row.cooldown_days >= 0
    ? row.cooldown_days
    : DEFAULT_COOLDOWN_DAYS;
  return new Date(at + days * DAY_MS);
}

/** A card is cooling down while dismissed_at + cooldown_days > now. */
export function isCoolingDown(row: Pick<EnrichmentDismissRow, 'dismissed_at' | 'cooldown_days'>, now: Date): boolean {
  const until = dismissedUntil(row);
  return until !== null && until.getTime() > now.getTime();
}

export interface EligibleEnrichmentCard {
  card_type: EnrichmentCardType;
  category: 'enrichment';
  priority: number;
}

/**
 * The one rule for which enrichment cards a member sees on a screen:
 * on that screen's list, known to be incomplete (`completions.get(t) === false`
 * — a card with no known state is not shown), not cooling down, and not
 * `unavailable` — a card whose action cannot work on this stack (VTID-05211:
 * E6/E7 while the Meta OAuth client is not configured; the caller computes
 * the set with `unavailableEnrichmentCards()` so this module stays pure).
 * Returned in static priority order. Unknown screens return [].
 */
export function eligibleEnrichmentCards(
  completions: ReadonlyMap<string, boolean>,
  dismissRows: readonly EnrichmentDismissRow[],
  screen: string,
  now: Date,
  unavailable: ReadonlySet<string> = new Set(),
): EligibleEnrichmentCard[] {
  if (!isCardScreen(screen)) return [];
  const onScreen = new Set<EnrichmentCardType>(SCREEN_ENRICHMENT_CARDS[screen]);
  const coolingDown = new Set<string>();
  for (const row of dismissRows) {
    if (isCoolingDown(row, now)) coolingDown.add(row.card_type);
  }
  return ENRICHMENT_PRIORITY
    .filter((t) => onScreen.has(t))
    .filter((t) => completions.get(t) === false)
    .filter((t) => !coolingDown.has(t))
    .filter((t) => !unavailable.has(t))
    .map((t) => ({ card_type: t, category: 'enrichment' as const, priority: enrichmentPriority(t) }));
}

export type EligibleBoostCard = BoostTrigger & {
  category: 'boost';
  priority: number;
};

/**
 * The one rule for which boost cards a member sees on a screen: on that
 * screen's list, trigger fired, and not cooling down (same dismissal table
 * and cooldown as enrichment cards). Returned in urgency order G3 → G2 → G1.
 * A card with no computed trigger is not shown. Unknown screens return [].
 */
export function eligibleBoostCards(
  boosts: BoostTriggers,
  dismissRows: readonly EnrichmentDismissRow[],
  screen: string,
  now: Date,
): EligibleBoostCard[] {
  if (!isCardScreen(screen)) return [];
  const onScreen = new Set<BoostCardType>(SCREEN_BOOST_CARDS[screen]);
  const coolingDown = new Set<string>();
  for (const row of dismissRows) {
    if (isCoolingDown(row, now)) coolingDown.add(row.card_type);
  }
  const out: EligibleBoostCard[] = [];
  for (const t of BOOST_PRIORITY) {
    const trigger = boosts.get(t);
    if (!onScreen.has(t) || !trigger || trigger.card_type !== t || !trigger.fired || coolingDown.has(t)) continue;
    out.push({ ...trigger, category: 'boost', priority: boostPriority(t) });
  }
  return out;
}

/**
 * Share of the 11 enrichment cards already completed, 0–100 (rounded).
 * Phase 3's G1 trigger uses the frontend's weighted profile progress instead
 * (useProfileProgress.ts); this number is the enrichment progress only.
 */
export function enrichmentCompletionPct(completions: ReadonlyMap<string, boolean>): number {
  const done = ENRICHMENT_CARD_TYPES.filter((t) => completions.get(t) === true).length;
  return Math.round((done / ENRICHMENT_CARD_TYPES.length) * 100);
}
