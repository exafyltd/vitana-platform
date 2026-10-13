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
 * Boost cards (G1–G3) get their triggers in Phase 3 (VTID-05087); feature
 * cards (F1–F11) are a static per-screen list in the frontend. Neither is
 * served from this catalog yet. Pure module: no I/O, no clock reads.
 */

export const ENRICHMENT_CARD_TYPES = [
  'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9', 'E10', 'E11',
] as const;
export type EnrichmentCardType = (typeof ENRICHMENT_CARD_TYPES)[number];

/** Boost cards with a trigger in scope (Phase 3). G4 stays deferred (plan §2C). */
export const BOOST_CARD_TYPES = ['G1', 'G2', 'G3'] as const;
export type BoostCardType = (typeof BOOST_CARD_TYPES)[number];

export type CardCategory = 'enrichment' | 'boost';

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
 *   - calendar: E8 only (plan §4 Calendar: "Enrichment: E8").
 *   - messenger: E1–E11 (VTID-05099: the companion engine picks one).
 *   - vitana-index, talk-to-vitana: no enrichment cards in the plan.
 */
export const SCREEN_ENRICHMENT_CARDS: Readonly<Record<CardScreen, readonly EnrichmentCardType[]>> = {
  home: ALL_ENRICHMENT,
  profile: ALL_ENRICHMENT,
  'longevity-journey': ['E4', 'E5'],
  calendar: ['E8'],
  'vitana-index': [],
  autopilot: ['E10'],
  community: ['E3', 'E6', 'E7'],
  'make-a-post': ['E3'],
  'talk-to-vitana': [],
  messenger: ALL_ENRICHMENT,
};

export const DEFAULT_COOLDOWN_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export function isCardScreen(value: unknown): value is CardScreen {
  return typeof value === 'string' && (CARD_SCREENS as readonly string[]).includes(value);
}

export function isEnrichmentCardType(value: unknown): value is EnrichmentCardType {
  return typeof value === 'string' && (ENRICHMENT_CARD_TYPES as readonly string[]).includes(value);
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
 * — a card with no known state is not shown), and not cooling down.
 * Returned in static priority order. Unknown screens return [].
 */
export function eligibleEnrichmentCards(
  completions: ReadonlyMap<string, boolean>,
  dismissRows: readonly EnrichmentDismissRow[],
  screen: string,
  now: Date,
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
    .map((t) => ({ card_type: t, category: 'enrichment' as const, priority: enrichmentPriority(t) }));
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
