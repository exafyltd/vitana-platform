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
 *
 * Extended (still VTID-03702) to also cover routes/admin-community-
 * marketplace.ts — the admin review-queue router for these same tables.
 * Its embedded-join reads (profiles/community_listings via `!inner`-less
 * foreign-table select) and unfiltered-columns update shapes differ from
 * the seller/buyer router's, so they get their own named functions rather
 * than reusing fetchListings/updateListing etc.
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
  const { data, error } = await supabase!
    .from('community_listing_categories')
    .select('key, listing_kind, is_prohibited, requires_verified_provider, requires_admin_review_always, is_active')
    .eq('key', key)
    .maybeSingle();
  if (error) {
    // Both call sites already fail closed on a null return (400
    // invalid_category), which is the safe outcome for a real DB error
    // too — but logged so a spike of "invalid category" reports isn't
    // silently indistinguishable from an actual DB failure.
    console.error(`[community-marketplace] fetchCategory query failed for key=${key}: ${error.message}`);
  }
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

// ==================== Admin review queue (admin-community-marketplace.ts) ====================

export interface AdminListingsQueueFilters {
  tenantId: string | null;
  requiresAdminReview?: boolean;
  status?: string;
  category?: string;
  listingKind?: string;
  search?: string;
  offset: number;
  limit: number;
}

export async function fetchAdminListingsQueue(supabase: Supabase, f: AdminListingsQueueFilters) {
  let q = supabase!
    .from('community_listings')
    .select(
      'id, seller_user_id, listing_kind, condition, category, subcategory, title, description, images, ' +
        'price_cents, currency, price_on_request, status, auto_check_result, auto_check_reasons, ' +
        'requires_admin_review, admin_review_reason, admin_notes, reviewed_by, reviewed_at, created_at, updated_at, ' +
        'profiles:seller_user_id(display_name, vitana_id)',
      { count: 'exact' },
    )
    .eq('tenant_id', f.tenantId);

  if (f.requiresAdminReview !== undefined) q = q.eq('requires_admin_review', f.requiresAdminReview);
  if (f.status) q = q.eq('status', f.status);
  if (f.category) q = q.eq('category', f.category);
  if (f.listingKind) q = q.eq('listing_kind', f.listingKind);
  if (f.search) q = q.ilike('title', `%${f.search}%`);

  q = q
    .order('requires_admin_review', { ascending: false })
    .order('created_at', { ascending: false })
    .range(f.offset, f.offset + f.limit - 1);

  return q;
}

export async function fetchListingForAdminEdit(supabase: Supabase, id: string, tenantId: string | null) {
  return supabase!.from('community_listings').select('id, status').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
}

export async function updateListingAdmin(supabase: Supabase, id: string, patch: Record<string, unknown>) {
  return supabase!.from('community_listings').update(patch).eq('id', id).select().single();
}

export async function fetchListingsForBulkAction(supabase: Supabase, tenantId: string | null, listingIds: string[]) {
  return supabase!.from('community_listings').select('id, seller_user_id, title, status').eq('tenant_id', tenantId).in('id', listingIds);
}

export async function bulkUpdateListings(supabase: Supabase, ids: string[], patch: Record<string, unknown>) {
  return supabase!.from('community_listings').update(patch).in('id', ids);
}

export async function upsertSellerSuspension(supabase: Supabase, row: Record<string, unknown>) {
  return supabase!.from('community_marketplace_seller_suspensions').upsert(row);
}

export async function deleteSellerSuspension(supabase: Supabase, userId: string, tenantId: string | null) {
  return supabase!.from('community_marketplace_seller_suspensions').delete().eq('seller_user_id', userId).eq('tenant_id', tenantId);
}

export async function fetchActiveListingsForSeller(supabase: Supabase, userId: string, tenantId: string | null) {
  return supabase!
    .from('community_listings')
    .select('id, status')
    .eq('seller_user_id', userId)
    .eq('tenant_id', tenantId)
    .in('status', ['active', 'paused']);
}

export interface AdminReportsQueueFilters {
  tenantId: string | null;
  status?: string;
  offset: number;
  limit: number;
}

export async function fetchAdminReportsQueue(supabase: Supabase, f: AdminReportsQueueFilters) {
  let q = supabase!
    .from('community_listing_reports')
    .select(
      'id, listing_id, reporter_user_id, report_reason, report_note, status, admin_notes, resolved_by, resolved_at, created_at, ' +
        'community_listings:listing_id(title, status, seller_user_id)',
      { count: 'exact' },
    )
    .eq('tenant_id', f.tenantId);
  if (f.status) q = q.eq('status', f.status);
  else q = q.in('status', ['received', 'under_review']);

  q = q.order('created_at', { ascending: false }).range(f.offset, f.offset + f.limit - 1);

  return q;
}

export async function updateReport(supabase: Supabase, id: string, tenantId: string | null, patch: Record<string, unknown>) {
  return supabase!.from('community_listing_reports').update(patch).eq('id', id).eq('tenant_id', tenantId).select().single();
}

export async function fetchAllCategoriesAdmin(supabase: Supabase) {
  return supabase!
    .from('community_listing_categories')
    .select('key, listing_kind, display_label, parent_key, is_prohibited, requires_verified_provider, requires_admin_review_always, is_active, sort_order')
    .order('sort_order', { ascending: true });
}

export async function updateCategory(supabase: Supabase, key: string, patch: Record<string, unknown>) {
  return supabase!.from('community_listing_categories').update(patch).eq('key', key).select().maybeSingle();
}
