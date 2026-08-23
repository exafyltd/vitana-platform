/**
 * BOOTSTRAP-COMMUNITY-MARKETPLACE — Aurora migration B1 data-access seam
 * (VTID-03702, "Supabase→Aurora migration" workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase call `routes/community-marketplace.ts` makes against
 * marketplace-owned tables (community_listings, community_listing_*,
 * community_marketplace_seller_suspensions, listing_status_history) now goes
 * through here instead of calling `supabase.from(...)` inline. This is a
 * PURE MOVE, not a rewrite: each function below is the exact same query
 * chain that used to live in the route handler, same columns, same
 * filters, same `{ data, error }`/`{ data, error, count }` return shape the
 * route already destructured — no behavior change today.
 *
 * Why this matters for the migration: once the gateway eventually opens a
 * real Postgres connection to Aurora instead of speaking PostgREST, only
 * the internals of these functions change (swap the supabase-js call for a
 * `pg` query) — none of the ~25 call sites in the route file need to move
 * again. Same pattern as services/specialists/specialists-repository.ts,
 * services/db-i18n/db-i18n-repository.ts, services/social-memory/
 * social-memory-repository.ts (all VTID-03498/03515/03517/BOOTSTRAP-SOCIAL-
 * MEMORY precedents).
 *
 * Deliberately OUT of scope here: reads against `profiles` /
 * `global_community_profiles` (generic, not marketplace-owned — those stay
 * inline in the route, same as other B1 seams leave shared/general tables
 * alone rather than claiming them for a single-domain repository).
 */

import { getSupabase } from '../../lib/supabase';
import type { ModerationCategoryInfo } from './listing-moderation-check';

type Supabase = ReturnType<typeof getSupabase>;

export const PUBLIC_LISTING_COLUMNS =
  'id, tenant_id, seller_user_id, listing_kind, condition, category, subcategory, title, description, images, ' +
  'price_cents, currency, price_on_request, location_text, is_remote_service, delivery_method, ' +
  'requires_verified_provider, status, sold_at, renewed_at, expires_at, view_count, contact_click_count, created_at, updated_at';

export const OWNER_ONLY_COLUMNS =
  'auto_check_result, auto_check_reasons, requires_admin_review, admin_review_reason, admin_notes, reviewed_at';

// ==================== Categories ====================

export async function fetchActiveCategories(supabase: Supabase, listingKind?: 'product' | 'service') {
  let query = supabase!
    .from('community_listing_categories')
    .select('key, listing_kind, display_label, parent_key, sort_order')
    .eq('is_active', true)
    .eq('is_prohibited', false)
    .order('sort_order', { ascending: true });
  if (listingKind === 'product' || listingKind === 'service') {
    query = query.in('listing_kind', [listingKind, 'both']);
  }
  return query;
}

export async function fetchCategory(supabase: Supabase, key: string): Promise<ModerationCategoryInfo | null> {
  const { data } = await supabase!
    .from('community_listing_categories')
    .select('key, listing_kind, is_prohibited, requires_verified_provider, requires_admin_review_always, is_active')
    .eq('key', key)
    .maybeSingle();
  if (!data || !data.is_active) return null;
  return {
    key: data.key,
    is_prohibited: data.is_prohibited,
    requires_verified_provider: data.requires_verified_provider,
    requires_admin_review_always: data.requires_admin_review_always,
  };
}

// ==================== Seller blocks ====================

export async function fetchBlockedSellerIds(supabase: Supabase, viewerUserId: string) {
  return supabase!.from('community_listing_seller_blocks').select('blocked_seller_id').eq('viewer_user_id', viewerUserId);
}

export async function checkSellerBlocked(supabase: Supabase, viewerUserId: string, sellerUserId: string) {
  return supabase!
    .from('community_listing_seller_blocks')
    .select('id')
    .eq('viewer_user_id', viewerUserId)
    .eq('blocked_seller_id', sellerUserId)
    .maybeSingle();
}

export async function fetchSellerBlocks(supabase: Supabase, viewerUserId: string) {
  return supabase!
    .from('community_listing_seller_blocks')
    .select('id, blocked_seller_id, reason, created_at, profiles:blocked_seller_id(display_name, vitana_id)')
    .eq('viewer_user_id', viewerUserId)
    .order('created_at', { ascending: false });
}

export async function upsertSellerBlock(
  supabase: Supabase,
  row: { viewer_user_id: string; blocked_seller_id: string; tenant_id: string; reason: string | null },
) {
  return supabase!
    .from('community_listing_seller_blocks')
    .upsert(row, { onConflict: 'viewer_user_id,blocked_seller_id' })
    .select('id')
    .single();
}

export async function deleteSellerBlock(supabase: Supabase, viewerUserId: string, blockedSellerId: string) {
  return supabase!
    .from('community_listing_seller_blocks')
    .delete()
    .eq('viewer_user_id', viewerUserId)
    .eq('blocked_seller_id', blockedSellerId);
}

// ==================== Seller suspensions ====================

export async function checkSellerSuspended(supabase: Supabase, sellerUserId: string) {
  return supabase!
    .from('community_marketplace_seller_suspensions')
    .select('seller_user_id')
    .eq('seller_user_id', sellerUserId)
    .maybeSingle();
}

// ==================== Listings: browse / read ====================

export interface BrowseListingsFilters {
  tenantId: string;
  blockedSellerIds: string[];
  category?: string;
  subcategory?: string;
  listingKind?: 'product' | 'service';
  condition?: string;
  deliveryMethod?: string;
  minPriceCents?: number;
  maxPriceCents?: number;
  q?: string;
  sort: 'newest' | 'price_asc' | 'price_desc';
  limit: number;
  offset: number;
}

export async function fetchListings(supabase: Supabase, f: BrowseListingsFilters) {
  let query = supabase!
    .from('community_listings')
    .select(PUBLIC_LISTING_COLUMNS, { count: 'exact' })
    .eq('tenant_id', f.tenantId)
    .eq('status', 'active');

  if (f.blockedSellerIds.length > 0) query = query.not('seller_user_id', 'in', `(${f.blockedSellerIds.join(',')})`);
  if (f.category) query = query.eq('category', f.category);
  if (f.subcategory) query = query.eq('subcategory', f.subcategory);
  if (f.listingKind) query = query.eq('listing_kind', f.listingKind);
  if (f.condition) query = query.eq('condition', f.condition);
  if (f.deliveryMethod) query = query.eq('delivery_method', f.deliveryMethod);
  if (f.minPriceCents !== undefined) query = query.gte('price_cents', f.minPriceCents);
  if (f.maxPriceCents !== undefined) query = query.lte('price_cents', f.maxPriceCents);
  if (f.q) query = query.textSearch('search_text', f.q, { type: 'websearch' });

  if (f.sort === 'price_asc') query = query.order('price_cents', { ascending: true, nullsFirst: false });
  else if (f.sort === 'price_desc') query = query.order('price_cents', { ascending: false, nullsFirst: false });
  else query = query.order('created_at', { ascending: false });

  query = query.range(f.offset, f.offset + f.limit - 1);
  return query;
}

export async function fetchMyListings(
  supabase: Supabase,
  sellerUserId: string,
  statusFilter: string | undefined,
  limit: number,
  offset: number,
) {
  let query = supabase!
    .from('community_listings')
    .select(`${PUBLIC_LISTING_COLUMNS}, ${OWNER_ONLY_COLUMNS}`, { count: 'exact' })
    .eq('seller_user_id', sellerUserId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (statusFilter) query = query.eq('status', statusFilter);
  return query;
}

export async function fetchListingsBySeller(supabase: Supabase, tenantId: string, sellerUserId: string) {
  return supabase!
    .from('community_listings')
    .select(PUBLIC_LISTING_COLUMNS)
    .eq('tenant_id', tenantId)
    .eq('seller_user_id', sellerUserId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .range(0, 19);
}

export async function fetchListingById(supabase: Supabase, id: string, tenantId: string) {
  return supabase!
    .from('community_listings')
    .select(`${PUBLIC_LISTING_COLUMNS}, ${OWNER_ONLY_COLUMNS}`)
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
}

export async function fetchListingForEdit(supabase: Supabase, id: string, sellerUserId: string) {
  return supabase!.from('community_listings').select('*').eq('id', id).eq('seller_user_id', sellerUserId).maybeSingle();
}

export async function fetchListingForStatusChange(supabase: Supabase, id: string, sellerUserId: string) {
  return supabase!
    .from('community_listings')
    .select('id, status, seller_user_id')
    .eq('id', id)
    .eq('seller_user_id', sellerUserId)
    .maybeSingle();
}

export async function fetchListingForContactClick(supabase: Supabase, id: string, tenantId: string) {
  return supabase!
    .from('community_listings')
    .select('id, seller_user_id, status, contact_click_count')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .in('status', ['active', 'paused'])
    .maybeSingle();
}

export async function fetchListingForReport(supabase: Supabase, id: string, tenantId: string) {
  return supabase!
    .from('community_listings')
    .select('id, seller_user_id, status, requires_admin_review')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
}

// ==================== Listings: writes ====================

export async function insertListing(supabase: Supabase, row: Record<string, unknown>) {
  return supabase!
    .from('community_listings')
    .insert(row)
    .select(`${PUBLIC_LISTING_COLUMNS}, ${OWNER_ONLY_COLUMNS}`)
    .single();
}

export async function updateListing(supabase: Supabase, id: string, update: Record<string, unknown>) {
  return supabase!
    .from('community_listings')
    .update(update)
    .eq('id', id)
    .select(`${PUBLIC_LISTING_COLUMNS}, ${OWNER_ONLY_COLUMNS}`)
    .single();
}

/** Fire-and-forget counter bump (view_count / contact_click_count) — no select-back, matches prior inline behavior. */
export async function bumpListingCounter(supabase: Supabase, id: string, field: 'view_count' | 'contact_click_count', newValue: number) {
  return supabase!.from('community_listings').update({ [field]: newValue }).eq('id', id);
}

/** Same shape as bumpListingCounter's update, but also sets admin-review fields (auto-escalation path). */
export async function updateListingAdminReview(supabase: Supabase, id: string, update: Record<string, unknown>) {
  return supabase!.from('community_listings').update(update).eq('id', id);
}

export async function recordStatusHistory(
  supabase: Supabase,
  listingId: string,
  actorType: 'seller' | 'admin' | 'system',
  actorUserId: string | null,
  fromStatus: string | null,
  toStatus: string,
  reason: string,
): Promise<void> {
  await supabase!.from('listing_status_history').insert({
    listing_id: listingId,
    actor_type: actorType,
    actor_user_id: actorUserId,
    from_status: fromStatus,
    to_status: toStatus,
    reason,
  });
}

// ==================== Reports ====================

export async function insertReport(
  supabase: Supabase,
  row: { listing_id: string; reporter_user_id: string; tenant_id: string; report_reason: string; report_note: string | null },
) {
  return supabase!.from('community_listing_reports').insert(row).select('id').single();
}

export async function countActiveReports(supabase: Supabase, listingId: string) {
  return supabase!
    .from('community_listing_reports')
    .select('id', { count: 'exact', head: true })
    .eq('listing_id', listingId)
    .neq('status', 'dismissed');
}
