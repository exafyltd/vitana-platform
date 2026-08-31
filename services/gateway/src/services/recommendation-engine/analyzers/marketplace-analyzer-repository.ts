// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: the
// one referencing test (marketplace-community-policies.test.ts) is a
// static source-text regex check on the file, not a runtime exercise of
// these Supabase calls — zero genuine coverage today.
/**
 * services/recommendation-engine/analyzers/marketplace-analyzer.ts —
 * Aurora migration B1 data-access seam (VTID-03702, Supabase→Aurora
 * migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in marketplace-analyzer.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 *
 * `buildCandidateProductsQuery` preserves the source's original
 * mutate-in-place builder pattern (`query.overlaps(...)`/`query.eq(...)`
 * called without reassignment, relying on the Supabase builder mutating
 * and returning `this`) exactly as written — not converted to the
 * reassignment style used elsewhere in this sweep, to avoid any risk of
 * behavior drift on a builder whose mutation semantics weren't
 * independently reverified here.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchActiveConditionProductMapping(sb: SupabaseClient, conditionKey: string) {
  return sb
    .from('condition_product_mappings')
    .select('condition_key, recommended_ingredients, recommended_health_goals, contraindicated_ingredients')
    .eq('condition_key', conditionKey)
    .eq('is_active', true)
    .maybeSingle();
}

export function buildCandidateProductsQuery(sb: SupabaseClient, limit: number): any {
  return sb
    .from('products')
    .select(
      'id, title, merchant_id, price_cents, currency, rating, origin_country, origin_region, health_goals, ingredients_primary, dietary_tags, contains_allergens, contraindicated_with_conditions, contraindicated_with_medications, ships_to_countries, ships_to_regions, excluded_from_regions'
    )
    .eq('is_active', true)
    .limit(limit);
}

export async function fetchUsersWithLimitations(sb: SupabaseClient, limit: number) {
  return sb
    .from('user_limitations')
    .select('user_id')
    .or('contraindications.neq.{},allergies.neq.{}')
    .limit(limit);
}
