// impact-allow-no-test: pure data-access seam (thin Supabase query/upsert
// wrappers, no independent request-handling behavior). Coverage note: NO
// call site here has any test coverage today —
// test/orb-tools/marketplace-guide-tools.test.ts only imports
// tool_capture_shopping_goal, tool_classify_marketplace_intent,
// tool_save_marketplace_preferences, tool_get_marketplace_preferences,
// tool_reset_marketplace_preferences, tool_complete_marketplace_selection,
// and tool_clarify_shopping_need — none of which touch these call sites.
// The functions that do (searchProductsForGoal, searchServicesForGoal,
// tool_get_marketplace_context, tool_dismiss_marketplace_recommendation)
// are never imported or exercised by that test file.
/**
 * services/orb-tools/marketplace-guide-tools.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in this file now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * `cols` is a runtime-derived column-list string (PRODUCT_COLS/SERVICE_COLS
 * from the caller) — same dynamic-select shape as the original inline
 * calls. Widening a literal column-list type to `string` here defeats
 * postgrest-js's compile-time column inference the same way it never could
 * inline, so the return type is annotated explicitly rather than left
 * inferred — callers already cast these rows via `as unknown as Row[]` /
 * `as Row[]`.
 */
export async function searchActiveProductsFullText(
  sb: SupabaseClient,
  cols: string,
  sanitizedGoal: string,
  budgetMaxCents: number | null,
  limit: number,
): Promise<{ data: any[] | null; error: any }> {
  let query = sb.from('products').select(cols).eq('is_active', true);
  if (sanitizedGoal) query = query.textSearch('search_text', sanitizedGoal, { config: 'simple', type: 'websearch' });
  if (budgetMaxCents != null) query = query.lte('price_cents', budgetMaxCents);
  return query.order('rating', { ascending: false, nullsFirst: false }).limit(limit);
}

export async function searchActiveProductsIlikeFallback(
  sb: SupabaseClient,
  cols: string,
  token: string,
  budgetMaxCents: number | null,
  limit: number,
): Promise<{ data: any[] | null; error: any }> {
  let query = sb.from('products').select(cols).eq('is_active', true).ilike('search_text', `%${token}%`);
  if (budgetMaxCents != null) query = query.lte('price_cents', budgetMaxCents);
  return query.order('rating', { ascending: false, nullsFirst: false }).limit(limit);
}

export async function searchServicesCatalogForGoal(
  sb: SupabaseClient,
  cols: string,
  tenantId: string,
  token: string | undefined,
  limit: number,
): Promise<{ data: any[] | null; error: any }> {
  let query = sb.from('services_catalog').select(cols).eq('tenant_id', tenantId);
  if (token) query = query.or(`name.ilike.%${token}%,provider_name.ilike.%${token}%`);
  return query.limit(limit);
}

export async function fetchUserBudgetMonthlyCapCents(sb: SupabaseClient, userId: string) {
  return sb.from('user_limitations').select('budget_monthly_cap_cents').eq('user_id', userId).maybeSingle();
}

export async function fetchRecentProductOrders(sb: SupabaseClient, userId: string, limit: number) {
  return sb
    .from('product_orders')
    .select('product_id, state, amount_cents, currency, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
}

export async function upsertDismissedOffer(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('user_offers_memory').upsert(row, { onConflict: 'tenant_id,user_id,target_type,target_id' });
}
