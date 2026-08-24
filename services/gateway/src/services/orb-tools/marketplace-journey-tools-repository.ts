/**
 * orb-tools/marketplace-journey-tools.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in orb-tools/marketplace-journey-tools.ts
 * now goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic, same
 * return shapes — no behavior change today. Client-agnostic (takes `sb` as
 * a param) — tools receive their client per-call, not a module-level
 * singleton.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== products ====================

/** Full dynamic product-need search — folds the whole conditional chain (websearch/ilike, budget, dietary, certifications, category, excludeId) so nothing chains further at the call site. */
export async function searchActiveProducts(
  sb: SupabaseClient,
  productCols: string,
  sanitizedNeed: string,
  useWebsearch: boolean,
  opts: {
    budgetMaxCents?: number | null;
    dietary?: string[];
    certifications?: string[];
    category?: string | null;
    excludeId?: string;
    limit: number;
  },
) {
  let query = sb.from('products').select(productCols).eq('is_active', true);
  if (sanitizedNeed) {
    if (useWebsearch) {
      query = query.textSearch('search_text', sanitizedNeed, { config: 'simple', type: 'websearch' });
    } else {
      const token = sanitizedNeed.split(/\s+/).sort((a, b) => b.length - a.length)[0];
      if (token && token.length >= 3) query = query.ilike('search_text', `%${token}%`);
    }
  }
  if (opts.budgetMaxCents != null) query = query.lte('price_cents', opts.budgetMaxCents);
  if (opts.dietary?.length) query = query.contains('dietary_tags', opts.dietary);
  if (opts.certifications?.length) query = query.contains('certifications', opts.certifications);
  if (opts.category) query = query.eq('category', opts.category);
  if (opts.excludeId) query = query.neq('id', opts.excludeId);
  return query.order('rating', { ascending: false, nullsFirst: false }).limit(Math.max(opts.limit * 3, 12));
}

export async function fetchProductTitles(sb: SupabaseClient, ids: string[]) {
  return sb.from('products').select('id, title').in('id', ids);
}

export async function searchProductsByIds(sb: SupabaseClient, productCols: string, ids: string[]) {
  return sb.from('products').select(productCols).in('id', ids);
}

export async function searchCheaperProductsInCategory(
  sb: SupabaseClient,
  productCols: string,
  category: string,
  maxPriceCents: number,
  excludeId: string,
  limit: number,
) {
  return sb
    .from('products')
    .select(productCols)
    .eq('is_active', true)
    .eq('category', category)
    .lt('price_cents', maxPriceCents)
    .neq('id', excludeId)
    .order('rating', { ascending: false, nullsFirst: false })
    .limit(limit);
}

// ==================== services_catalog ====================

export async function searchServicesCatalog(
  sb: SupabaseClient,
  serviceCols: string,
  tenantId: string,
  serviceTypes: string[] | undefined,
  orTokens: string[],
  limit: number,
) {
  let query = sb.from('services_catalog').select(serviceCols).eq('tenant_id', tenantId);
  if (serviceTypes?.length) query = query.in('service_type', serviceTypes);
  if (orTokens.length) {
    query = query.or(orTokens.map((t) => `name.ilike.%${t}%,provider_name.ilike.%${t}%`).join(','));
  }
  return query.limit(limit);
}

// ==================== universal_carts / universal_cart_items ====================

export async function fetchActiveCart(sb: SupabaseClient, userId: string) {
  return sb.from('universal_carts').select('id').eq('user_id', userId).eq('status', 'active').maybeSingle();
}

export async function fetchActiveCartItems(sb: SupabaseClient, cartId: string) {
  return sb
    .from('universal_cart_items')
    .select('id, product_id, item_type, quantity, status, unit_price_cents_snapshot, currency_snapshot, metadata')
    .eq('cart_id', cartId)
    .eq('status', 'active');
}

// ==================== shop_saved_products ====================

export async function fetchSavedProductRow(sb: SupabaseClient, userId: string, productId: string) {
  return sb.from('shop_saved_products').select('id').eq('user_id', userId).eq('product_id', productId).maybeSingle();
}

export async function insertSavedProduct(sb: SupabaseClient, userId: string, productId: string) {
  return sb.from('shop_saved_products').insert({ user_id: userId, product_id: productId });
}

export async function fetchSavedProductsForUser(sb: SupabaseClient, userId: string, limit: number) {
  return sb
    .from('shop_saved_products')
    .select('product_id, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
}

export async function deleteSavedProduct(sb: SupabaseClient, userId: string, productId: string) {
  return sb.from('shop_saved_products').delete().eq('user_id', userId).eq('product_id', productId).select('id');
}

// ==================== user_limitations ====================

export async function fetchBudgetMonthlyCap(sb: SupabaseClient, userId: string) {
  return sb.from('user_limitations').select('budget_monthly_cap_cents').eq('user_id', userId).maybeSingle();
}
