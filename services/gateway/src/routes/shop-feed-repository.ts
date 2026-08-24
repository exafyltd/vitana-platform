// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: NO
// call site in routes/shop-feed.ts has any test coverage today — no test
// file in this repo references this route.
/**
 * routes/shop-feed.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in routes/shop-feed.ts now goes through
 * here instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param) — call sites that used the user-JWT client (shop_saved_products
 * reads/writes, RLS owner-scoped) still pass that client in; the
 * service-role call sites (shop_videos, shop_video_anchors,
 * shop_video_events, products) still pass the service-role client in,
 * exactly as before.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchPrimaryShopVideoAnchors(sb: SupabaseClient, videoIds: string[]) {
  return sb
    .from('shop_video_anchors')
    .select('id, video_id, product_id, label, appear_at_ms, pos_x, pos_y, badge_price_cents, currency')
    .in('video_id', videoIds)
    .eq('is_primary', true);
}

/** Reused for both the anchor-hydration lookup and the saved-products hydration lookup — identical query shape. */
export async function fetchProductsByIds(sb: SupabaseClient, productIds: string[]) {
  return sb
    .from('products')
    .select('id, title, description, brand, category, subcategory, price_cents, currency, compare_at_price_cents, images, affiliate_url, availability, rating, review_count, origin_country, merchant_id, ingredients_primary, health_goals, dietary_tags, is_active')
    .in('id', productIds);
}

export async function insertShopVideoEvents(sb: SupabaseClient, rows: Record<string, unknown>[]) {
  return sb.from('shop_video_events').insert(rows);
}

export async function fetchRankedShopVideosPage(sb: SupabaseClient, rangeStart: number, rangeEnd: number) {
  return sb
    .from('shop_videos')
    .select('id, title, caption, creator_id, video_url, poster_url, thumbnail_url, duration_ms, aspect_ratio, rank_score, created_at')
    .eq('status', 'active')
    .eq('moderation_status', 'approved')
    .order('rank_score', { ascending: false })
    .order('created_at', { ascending: false })
    .range(rangeStart, rangeEnd);
}

export async function fetchShopVideoById(sb: SupabaseClient, videoId: string) {
  return sb
    .from('shop_videos')
    .select('id, title, caption, creator_id, video_url, poster_url, thumbnail_url, duration_ms, aspect_ratio, status, moderation_status')
    .eq('id', videoId)
    .maybeSingle();
}

export async function fetchShopVideoStatusById(sb: SupabaseClient, videoId: string) {
  return sb.from('shop_videos').select('id, status, moderation_status').eq('id', videoId).maybeSingle();
}

export async function fetchSavedProductsPage(sb: SupabaseClient, rangeStart: number, rangeEnd: number) {
  return sb
    .from('shop_saved_products')
    .select('id, product_id, video_id, created_at')
    .order('created_at', { ascending: false })
    .range(rangeStart, rangeEnd);
}

export async function upsertSavedProduct(
  sb: SupabaseClient,
  row: { user_id: string; product_id: string; video_id: string | null },
) {
  return sb
    .from('shop_saved_products')
    .upsert(row, { onConflict: 'user_id,product_id', ignoreDuplicates: true })
    .select('id, product_id, video_id, created_at')
    .maybeSingle();
}

export async function deleteSavedProduct(sb: SupabaseClient, userId: string, productId: string) {
  return sb.from('shop_saved_products').delete().eq('user_id', userId).eq('product_id', productId);
}
