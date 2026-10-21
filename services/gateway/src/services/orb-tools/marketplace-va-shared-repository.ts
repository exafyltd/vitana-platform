// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file imports marketplace-va-shared.ts directly, but every call site
// here is genuinely exercised indirectly through its two callers'
// suites — test/orb-tools/marketplace-guide-tools.test.ts and
// test/orb-tools/marketplace-journey-tools.test.ts (76 tests total,
// neither mocks this module — only the underlying supabase client is
// mocked). Confirmed: preference save/get/reset exercises
// loadMarketplacePrefs; goal/criteria/picks flows exercise loadGuideState/
// saveGuideState; "stages the cart (with audit event) only with
// confirm:true" exercises getOrCreateActiveCart/stageProductInCart.
// Cart-staging call sites treated with the same care as the sibling
// universal-cart/shopping-agent seams — this module's own docstring notes
// it never touches checkout/Stripe/wallet, staging only.
/**
 * services/orb-tools/marketplace-va-shared.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in marketplace-va-shared.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchTenantIdForUser(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('tenant_id').eq('user_id', userId).maybeSingle();
}

export async function fetchProductById(sb: SupabaseClient, productId: string) {
  return sb
    .from('products')
    .select('id, title, description, brand, category, subcategory, price_cents, currency, compare_at_price_cents, rating, review_count, availability, dietary_tags, health_goals, ingredients_primary, contains_allergens, ships_to_countries, dosage, serving_size, servings_per_container, safety_notes')
    .eq('id', productId)
    .eq('is_active', true)
    .maybeSingle();
}

export async function fetchProductByFuzzyTitle(sb: SupabaseClient, query: string) {
  return sb
    .from('products')
    .select('id, title, description, brand, category, subcategory, price_cents, currency, compare_at_price_cents, rating, review_count, availability, dietary_tags, health_goals, ingredients_primary, contains_allergens, ships_to_countries, dosage, serving_size, servings_per_container, safety_notes')
    .eq('is_active', true)
    .ilike('title', `%${query}%`)
    .order('rating', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
}

export async function fetchMarketplacePrefFacts(sb: SupabaseClient, tenantId: string, userId: string, prefKeys: readonly string[]) {
  return sb
    .from('memory_facts')
    .select('fact_key, fact_value')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .in('fact_key', [...prefKeys])
    .eq('entity', 'self')
    .is('superseded_by', null);
}

export async function fetchLatestGuideStateRow(sb: SupabaseClient, tenantId: string, userId: string, guideStateType: string) {
  return sb
    .from('memory_items')
    .select('id, content_json')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('content_json->>type', guideStateType)
    .order('occurred_at', { ascending: false })
    .limit(1);
}

export async function updateGuideStateRow(
  sb: SupabaseClient,
  rowId: string,
  patch: { content: string; content_json: Record<string, unknown>; occurred_at: string },
) {
  return sb.from('memory_items').update(patch).eq('id', rowId);
}

export async function insertGuideStateRow(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('memory_items').insert(row);
}

export async function fetchActiveUniversalCart(sb: SupabaseClient, userId: string) {
  return sb.from('universal_carts').select('id').eq('user_id', userId).eq('status', 'active').maybeSingle();
}

export async function insertUniversalCart(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('universal_carts').insert(row).select('id').single();
}

export async function insertUniversalCartItem(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('universal_cart_items').insert(row).select('id').single();
}
