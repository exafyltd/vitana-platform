// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references orb-tools/marketplace-discovery-tools.ts — zero
// coverage today.
/**
 * orb-tools/marketplace-discovery-tools.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in orb-tools/
 * marketplace-discovery-tools.ts now goes through here instead of being
 * written inline. PURE MOVE, not a rewrite: same queries, same columns,
 * same conditional-filter logic, same return shapes — no behavior
 * change today. Client-agnostic (takes `sb` as a param) — tools receive
 * their client per-call, not a module-level singleton.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

const PRODUCT_COLS =
  'id, title, description, brand, category, subcategory, price_cents, currency, compare_at_price_cents, rating, review_count, availability, affiliate_url, dosage, serving_size, safety_notes';
const SERVICE_COLS = 'id, name, service_type, provider_name, topic_keys, metadata';
const ORDER_COLS = 'id, product_id, state, amount_cents, currency, purchased_at, created_at';

export async function fetchTenantIdForAppUser(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('tenant_id').eq('user_id', userId).maybeSingle();
}

/** search_marketplace's builder — same conditional filters, same order/limit. */
export async function searchProducts(
  sb: SupabaseClient,
  opts: { sanitizedQuery: string | null; category: string | null; priceMin: number | null; priceMax: number | null; limit: number },
) {
  let query = sb.from('products').select(PRODUCT_COLS).eq('is_active', true);
  if (opts.sanitizedQuery) query = query.textSearch('search_text', opts.sanitizedQuery, { config: 'simple', type: 'websearch' });
  if (opts.category) query = query.eq('category', opts.category);
  if (opts.priceMin != null && Number.isFinite(opts.priceMin)) query = query.gte('price_cents', opts.priceMin);
  if (opts.priceMax != null && Number.isFinite(opts.priceMax)) query = query.lte('price_cents', opts.priceMax);
  return query.order('rating', { ascending: false, nullsFirst: false }).limit(opts.limit);
}

export async function fetchProductById(sb: SupabaseClient, productId: string) {
  return sb.from('products').select(PRODUCT_COLS).eq('id', productId).eq('is_active', true).maybeSingle();
}

export async function searchProductByTitleTop1(sb: SupabaseClient, query: string) {
  return sb.from('products').select(PRODUCT_COLS).eq('is_active', true).ilike('title', `%${query}%`).order('rating', { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
}

export async function fetchProductsByCategory(sb: SupabaseClient, category: string, limit: number) {
  return sb.from('products').select(PRODUCT_COLS).eq('is_active', true).eq('category', category).order('rating', { ascending: false, nullsFirst: false }).limit(limit);
}

export async function fetchServicesCatalogByTypes(sb: SupabaseClient, tenantId: string, serviceTypes: string[], limit: number) {
  return sb.from('services_catalog').select(SERVICE_COLS).eq('tenant_id', tenantId).in('service_type', serviceTypes).limit(limit);
}

export async function fetchServiceCatalogById(sb: SupabaseClient, tenantId: string, serviceId: string) {
  return sb.from('services_catalog').select(SERVICE_COLS).eq('tenant_id', tenantId).eq('id', serviceId).maybeSingle();
}

export async function searchServiceCatalogByName(sb: SupabaseClient, tenantId: string, query: string) {
  return sb.from('services_catalog').select(SERVICE_COLS).eq('tenant_id', tenantId).or(`name.ilike.%${query}%,provider_name.ilike.%${query}%`).limit(1).maybeSingle();
}

export async function fetchDealsProducts(sb: SupabaseClient) {
  return sb
    .from('products')
    .select(PRODUCT_COLS)
    .eq('is_active', true)
    .eq('availability', 'in_stock')
    .not('compare_at_price_cents', 'is', null)
    .order('rating', { ascending: false, nullsFirst: false })
    .limit(50);
}

export async function fetchActiveCartId(sb: SupabaseClient, userId: string) {
  return sb.from('universal_carts').select('id').eq('user_id', userId).eq('status', 'active').maybeSingle();
}

export async function insertActiveCartForUser(sb: SupabaseClient, userId: string, tenantId: string | null) {
  return sb.from('universal_carts').insert({ user_id: userId, tenant_id: tenantId, status: 'active', metadata: {} }).select('id').single();
}

/** Shared by get_ai_product_picks' insertPick and reorder_last_order — same
 * dynamic-payload insert + select('id').single() shape. */
export async function insertCartItemDynamic(sb: SupabaseClient, payload: Record<string, unknown>) {
  return sb.from('universal_cart_items').insert(payload).select('id').single();
}

export async function fetchMyOrders(sb: SupabaseClient, userId: string, limit: number) {
  return sb.from('product_orders').select(ORDER_COLS).eq('user_id', userId).order('created_at', { ascending: false }).limit(limit);
}

export async function fetchProductTitlesByIds(sb: SupabaseClient, productIds: string[]) {
  return sb.from('products').select('id, title').in('id', productIds);
}

export async function fetchOrderById(sb: SupabaseClient, orderId: string, userId: string) {
  return sb.from('product_orders').select(ORDER_COLS).eq('id', orderId).eq('user_id', userId).maybeSingle();
}

export async function fetchMostRecentOrder(sb: SupabaseClient, userId: string) {
  return sb.from('product_orders').select(ORDER_COLS).eq('user_id', userId).order('created_at', { ascending: false }).limit(1).maybeSingle();
}

export async function fetchProductTitleById(sb: SupabaseClient, productId: string) {
  return sb.from('products').select('title').eq('id', productId).maybeSingle();
}
