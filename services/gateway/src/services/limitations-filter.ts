/**
 * VTID-02000: Limitations filter — the non-negotiable substrate layer.
 *
 * Every endpoint that returns products to a user MUST run its product list
 * through `applyUserLimitations()`. Never bypassed except via explicit, logged,
 * single-query soft-bypass for the specific fields that allow it.
 *
 * Hard (never-overridable) categories:
 *   - allergies                — contains_allergens ∩ user.allergies
 *   - medical contraindications — contraindicated_with_conditions ∩ user.contraindications
 *   - medication interactions   — contraindicated_with_medications ∩ user.current_medications
 *   - legal/regional            — product.excluded_from_regions contains user.region_group
 *
 * Soft (overridable with explicit per-query intent, logged):
 *   - budget ceiling
 *   - dietary restrictions      (some stay hard when religious/cultural — see below)
 *   - ingredient sensitivities
 *
 * Always applied geo gate:
 *   - If user.country_code is known: product must have user.country_code in
 *     ships_to_countries OR user.region_group in ships_to_regions.
 *   - If not known: geo gate skipped (best-effort).
 */

import type { UserHealthContext } from './user-health-context';
import { emitLimitationViolation } from './reward-events';

export interface FilterableProduct {
  id: string;
  contains_allergens?: string[] | null;
  contraindicated_with_conditions?: string[] | null;
  contraindicated_with_medications?: string[] | null;
  excluded_from_regions?: string[] | null;
  ships_to_countries?: string[] | null;
  ships_to_regions?: string[] | null;
  dietary_tags?: string[] | null;
  ingredients_primary?: string[] | null;
  price_cents?: number | null;
  origin_region?: string | null;
  [k: string]: unknown;
}

export interface LimitationsFilterOptions {
  /** Per-query soft bypasses. Each MUST be backed by explicit user intent and logged elsewhere. */
  bypass_budget?: boolean;
  bypass_dietary?: boolean;
  bypass_sensitivities?: boolean;
  /** For violation-event emission — which surface the filter runs under. */
  surface?: string;
}

/** The limitations-only categories `applyUserLimitations()` tallies — everything except geo pre-filtering and past purchases, which its callers layer on separately. */
export interface LimitationsHiddenBreakdown {
  allergies: number;
  contraindications: number;
  medications: number;
  dietary: number;
  budget: number;
  sensitivities: number;
  geo: number;
  excluded_region: number;
}

/** The full per-reason tally a discover route reports in its response (`hidden_breakdown`/`hidden_total`). */
export interface HiddenBreakdown extends LimitationsHiddenBreakdown {
  past_purchases: number;
}

export interface LimitationsFilterResult<T extends FilterableProduct = FilterableProduct> {
  allowed: T[];
  hidden_breakdown: LimitationsHiddenBreakdown;
  violations: Array<{ product_id: string; reason: string }>;
}

function hasOverlap(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): string[] {
  if (!a?.length || !b?.length) return [];
  const setB = new Set(b.map((x) => x.toLowerCase()));
  const overlap: string[] = [];
  for (const item of a) {
    if (setB.has(item.toLowerCase())) overlap.push(item);
  }
  return overlap;
}

/**
 * Excludes already-purchased products from an allowed list and reports how
 * many were dropped, so callers can fold the count into `hidden_breakdown`
 * (VTID-03943 — discover-search.ts computed the exclusion but never reported
 * the count, so its transparency footer total silently undercounted; this
 * mirrors discover-feed.ts's equivalent inline computation as one shared,
 * independently testable function instead of two separately-maintained copies).
 */
export function excludePastPurchases<T extends { id: string }>(
  allowed: T[],
  pastPurchases: ReadonlyArray<{ product_id: string }>
): { withoutPast: T[]; past_purchases_hidden: number } {
  const pastIds = new Set(pastPurchases.map((p) => p.product_id));
  const withoutPast = allowed.filter((p) => !pastIds.has(p.id));
  return { withoutPast, past_purchases_hidden: allowed.length - withoutPast.length };
}

/**
 * Merges the three independent sources of "why was this hidden" into the one
 * `HiddenBreakdown` object a discover route reports (VTID-03945).
 *
 * Both discover-search.ts and discover-feed.ts filter in the same three
 * stages — a pre-filter geo pass (over the RAW fetched/candidate rows, before
 * `applyUserLimitations()` ever runs), `applyUserLimitations()` itself (which
 * has its own, smaller geo count for rows that slipped past the pre-filter —
 * e.g. no `country_code` known yet — but were still geo-excluded inside the
 * limitations pass), and `excludePastPurchases()`. Each route was manually
 * re-summing `geo` and re-spreading the other seven fields inline; extracting
 * that into one function means the summing rule (`geo = preFilterGeoHidden +
 * limitations.geo`) is written and tested once instead of twice, closing the
 * exact "two independently-maintained copies drift apart" shape VTID-03943
 * (and, earlier, VTID-03644/VTID-03696) already hit in this codebase.
 *
 * `limitations` is `undefined` when the caller has no `UserHealthContext`
 * (an anonymous/unauthenticated discover-search request) — every limitations
 * category then reports 0, since none of them ran.
 */
export function buildHiddenBreakdown(params: {
  preFilterGeoHidden: number;
  limitations: LimitationsHiddenBreakdown | undefined;
  pastPurchasesHidden: number;
}): HiddenBreakdown {
  const l = params.limitations;
  return {
    allergies: l?.allergies ?? 0,
    contraindications: l?.contraindications ?? 0,
    medications: l?.medications ?? 0,
    dietary: l?.dietary ?? 0,
    budget: l?.budget ?? 0,
    sensitivities: l?.sensitivities ?? 0,
    geo: params.preFilterGeoHidden + (l?.geo ?? 0),
    excluded_region: l?.excluded_region ?? 0,
    past_purchases: params.pastPurchasesHidden,
  };
}

/**
 * The core filter. Returns a struct separating allowed products from an
 * anonymous tally of why the rest were hidden (for the transparency footer).
 */
export function applyUserLimitations<T extends FilterableProduct>(
  products: T[],
  ctx: UserHealthContext,
  opts: LimitationsFilterOptions = {}
): LimitationsFilterResult<T> {
  const allowed: T[] = [];
  const violations: Array<{ product_id: string; reason: string }> = [];
  const hidden_breakdown = {
    allergies: 0,
    contraindications: 0,
    medications: 0,
    dietary: 0,
    budget: 0,
    sensitivities: 0,
    geo: 0,
    excluded_region: 0,
  };

  for (const p of products) {
    // ---- Hard filters (never bypass) ----

    const allergyOverlap = hasOverlap(p.contains_allergens, ctx.allergies);
    if (allergyOverlap.length > 0) {
      hidden_breakdown.allergies++;
      violations.push({ product_id: p.id, reason: `allergy:${allergyOverlap.join(',')}` });
      continue;
    }

    const conditionOverlap = hasOverlap(p.contraindicated_with_conditions, ctx.contraindications);
    if (conditionOverlap.length > 0) {
      hidden_breakdown.contraindications++;
      continue;
    }

    const medicationOverlap = hasOverlap(p.contraindicated_with_medications, ctx.current_medications);
    if (medicationOverlap.length > 0) {
      hidden_breakdown.medications++;
      continue;
    }

    // Explicit excluded-from-region (legal/regulatory)
    if (ctx.region_group && p.excluded_from_regions?.includes(ctx.region_group)) {
      hidden_breakdown.excluded_region++;
      continue;
    }

    // ---- Geo gate (skipped if user country unknown) ----
    if (ctx.country_code) {
      const countryMatch = (p.ships_to_countries ?? []).includes(ctx.country_code);
      const regionMatch = ctx.region_group ? (p.ships_to_regions ?? []).includes(ctx.region_group) : false;
      if (!countryMatch && !regionMatch) {
        hidden_breakdown.geo++;
        continue;
      }
    }

    // ---- Religious / cultural — stays HARD even though dietary is soft ----
    // Map: religious restrictions -> forbidden dietary/ingredient markers.
    // For Phase 0, keep simple — treat religious restrictions as dietary tags that MUST be present.
    if (ctx.religious_restrictions.length > 0) {
      const productTags = (p.dietary_tags ?? []).map((t) => t.toLowerCase());
      const missing = ctx.religious_restrictions.filter((r) => !productTags.includes(r.toLowerCase()));
      if (missing.length > 0) {
        hidden_breakdown.dietary++;
        continue;
      }
    }

    // ---- Soft filters (honor unless bypassed) ----

    if (!opts.bypass_dietary && ctx.dietary_restrictions.length > 0) {
      const productTags = (p.dietary_tags ?? []).map((t) => t.toLowerCase());
      const missing = ctx.dietary_restrictions.filter((r) => !productTags.includes(r.toLowerCase()));
      if (missing.length > 0) {
        hidden_breakdown.dietary++;
        continue;
      }
    }

    if (!opts.bypass_budget && ctx.budget_max_per_product_cents !== null &&
        p.price_cents !== null && p.price_cents !== undefined &&
        p.price_cents > ctx.budget_max_per_product_cents) {
      hidden_breakdown.budget++;
      continue;
    }

    if (!opts.bypass_sensitivities && ctx.ingredient_sensitivities.length > 0) {
      const sensOverlap = hasOverlap(p.ingredients_primary, ctx.ingredient_sensitivities);
      if (sensOverlap.length > 0) {
        hidden_breakdown.sensitivities++;
        continue;
      }
    }

    allowed.push(p);
  }

  // If violations were recorded, emit one consolidated P1 event per product
  // so the trust-and-safety alert fires. This only happens when a product
  // slipped into the input despite known user limitations — which should be
  // impossible if filters are correctly ordered, but we defensively check.
  if (violations.length > 0 && ctx.tenant_id) {
    for (const v of violations.slice(0, 5)) {
      const [field, ...values] = v.reason.split(':');
      emitLimitationViolation({
        user_id: ctx.user_id,
        tenant_id: ctx.tenant_id,
        product_id: v.product_id,
        violated_field: field === 'allergy' ? 'allergies' : field,
        violated_values: values.join(':').split(','),
        surface: opts.surface ?? 'unknown',
      }).catch(() => {});
    }
  }

  return { allowed, hidden_breakdown, violations };
}

/**
 * Compact summary for a product detail page ("we can show this because we
 * checked X, Y, Z"). Useful for transparency UX.
 */
export function explainLimitationsCheck(ctx: UserHealthContext): string {
  const parts: string[] = [];
  if (ctx.allergies.length) parts.push(`allergies (${ctx.allergies.join(', ')})`);
  if (ctx.dietary_restrictions.length) parts.push(`dietary (${ctx.dietary_restrictions.join(', ')})`);
  if (ctx.contraindications.length) parts.push(`health conditions (${ctx.contraindications.join(', ')})`);
  if (ctx.current_medications.length) parts.push(`medications`);
  if (ctx.budget_max_per_product_cents) parts.push(`budget (max €${Math.floor(ctx.budget_max_per_product_cents / 100)})`);
  if (ctx.country_code) parts.push(`shipping to ${ctx.country_code}`);
  return parts.length ? `Filtered against: ${parts.join(', ')}.` : 'No active limitations.';
}
