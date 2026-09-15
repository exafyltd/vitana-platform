// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note:
// no test file references routes/click-redirect.ts — zero coverage
// today.
/**
 * routes/click-redirect.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in
 * routes/click-redirect.ts now goes through here instead of being
 * written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same conditional-filter logic, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchActiveProductForRedirect(sb: SupabaseClient, productId: string) {
  return sb
    .from('products')
    .select(
      'id, title, brand, merchant_id, affiliate_url, source_network, origin_country, ships_to_countries, ships_to_regions, is_active',
    )
    .eq('id', productId)
    .eq('is_active', true)
    .maybeSingle();
}

export async function fetchAppUserGeoContext(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('country_code, delivery_country_code, region_group').eq('user_id', userId).maybeSingle();
}

export async function fetchRegionGroupForCountry(sb: SupabaseClient, countryCode: string) {
  return sb.rpc('get_region_group', { p_country_code: countryCode });
}

export function insertProductClick(
  sb: SupabaseClient,
  row: Record<string, unknown>,
): PromiseLike<{ error: { message: string } | null }> {
  return sb.from('product_clicks').insert(row);
}

export function incrementProductRecommendationClick(
  sb: SupabaseClient,
  recommendationId: string,
): PromiseLike<{ error: { message: string } | null }> {
  return sb.rpc('increment_product_recommendation_click', { p_recommendation_id: recommendationId });
}
