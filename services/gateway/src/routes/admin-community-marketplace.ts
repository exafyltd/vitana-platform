/**
 * BOOTSTRAP-COMMUNITY-MARKETPLACE — Chunk 7: admin review queue for the
 * peer-to-peer classifieds feature (listings, reports, seller suspensions,
 * category taxonomy). Mirrors admin-marketplace.ts's shape (same
 * requireTenantAdmin gate, same GET-list/PATCH-single/POST-bulk-action
 * pattern) but for community_listings, not the curated affiliate catalog.
 *
 * Mounted at /api/v1/admin/community-marketplace. This is a DIFFERENT
 * surface from the existing (unrelated, unfinished) admin-moderation.ts —
 * that file is left untouched.
 */

import { Router, Request, Response } from 'express';
import { requireTenantAdmin } from '../middleware/require-tenant-admin';
import { AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { emitOasisEvent } from '../services/oasis-event-service';
import type { CicdEventType } from '../types/cicd';
import { notifyUserAsync } from '../services/notification-service';
import { tt } from '../i18n/catalog';
import { bulkGetUserLocales } from '../i18n/server-locale';
import { recordStatusHistory } from './community-marketplace';
import * as repo from '../services/community-marketplace/community-marketplace-repository';

const router = Router();
router.use(requireTenantAdmin);

const VTID = 'BOOTSTRAP-COMMUNITY-MARKETPLACE';

function getTenantId(req: Request): string | null {
  return (req as AuthenticatedRequest).identity?.tenant_id ?? null;
}
function getAdminUserId(req: Request): string | null {
  return (req as AuthenticatedRequest).identity?.user_id ?? null;
}

async function emitAdminActivity(
  req: Request,
  type: CicdEventType,
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: VTID,
      type,
      source: 'gateway',
      status: 'info',
      message,
      payload: { ...payload, tenant_id: getTenantId(req), admin_user_id: getAdminUserId(req) },
    });
  } catch { /* non-fatal */ }
}

// ==================== GET /listings (review queue + full admin list) ====================

router.get('/listings', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const tenantId = getTenantId(req);
  const { requires_admin_review, status, category, listing_kind, search, limit, offset } = req.query;

  const { data, error, count } = await repo.fetchAdminListingsQueue(supabase, {
    tenantId,
    requiresAdminReview: requires_admin_review !== undefined ? String(requires_admin_review) === 'true' : undefined,
    status: status ? String(status) : undefined,
    category: category ? String(category) : undefined,
    listingKind: listing_kind ? String(listing_kind) : undefined,
    search: search ? String(search) : undefined,
    offset: Number(offset ?? 0),
    limit: Number(limit ?? 50),
  });
  if (error) return res.status(500).json({ ok: false, error: error.message });

  const items = (data ?? []).map((row: any) => ({
    ...row,
    seller_display_name: row.profiles?.display_name ?? null,
    seller_vitana_id: row.profiles?.vitana_id ?? null,
    profiles: undefined,
  }));

  res.json({ ok: true, items, total: count ?? 0 });
});

// ==================== PATCH /listings/:id ====================

router.patch('/listings/:id', async (req: Request, res: Response) => {
  // impact-allow-no-oasis: emitAdminActivity() below wraps emitOasisEvent —
  // the static impact-scan can't see through the indirection.
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const { id } = req.params;
  const allowed = ['admin_notes', 'admin_review_reason', 'requires_admin_review', 'status'];
  const patch: Record<string, unknown> = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
  if (Object.keys(patch).length === 0) return res.status(400).json({ ok: false, error: 'no_allowed_fields' });

  const { data: existing, error: existingErr } = await repo.fetchListingForAdminEdit(supabase, id, getTenantId(req));
  if (existingErr) return res.status(500).json({ ok: false, error: existingErr.message });
  if (!existing) return res.status(404).json({ ok: false, error: 'listing_not_found' });

  if (typeof patch.status === 'string') {
    patch.reviewed_by = getAdminUserId(req);
    patch.reviewed_at = new Date().toISOString();
  }

  const { data, error } = await repo.updateListingAdmin(supabase, id, patch);
  if (error) return res.status(500).json({ ok: false, error: error.message });

  if (typeof patch.status === 'string' && patch.status !== existing.status) {
    await recordStatusHistory(supabase, id, 'admin', getAdminUserId(req), existing.status, patch.status, 'admin_direct_edit');
  }
  await emitAdminActivity(req, 'community_marketplace.admin.listing_reviewed', 'Admin edited a community listing', {
    listing_id: id,
    patch,
  });

  res.json({ ok: true, listing: data });
});

// ==================== POST /listings/bulk-action ====================

const BULK_ACTION_PATCH: Record<string, Record<string, unknown>> = {
  hide: { status: 'paused' },
  reject: { status: 'removed', requires_admin_review: false },
  suspend_listing: { status: 'suspended', requires_admin_review: false },
  clear_review: { status: 'active', requires_admin_review: false, admin_review_reason: null },
  flag_review: { requires_admin_review: true },
  reactivate: { status: 'active', requires_admin_review: false, admin_review_reason: null },
};

// Actions whose outcome the seller should be told about via push/in-app —
// the rest (hide, suspend_listing, flag_review) are deliberately silent:
// hide/flag are provisional (not a final verdict yet), and a suspension is
// an enforcement action, not something to tip the seller off about.
const NOTIFY_ACTION: Record<string, 'notif.marketplace_listing_approved' | 'notif.marketplace_listing_rejected' | null> = {
  hide: null,
  reject: 'notif.marketplace_listing_rejected',
  suspend_listing: null,
  clear_review: 'notif.marketplace_listing_approved',
  flag_review: null,
  reactivate: 'notif.marketplace_listing_approved',
};

router.post('/listings/bulk-action', async (req: Request, res: Response) => {
  // impact-allow-no-oasis: emitAdminActivity() below wraps emitOasisEvent —
  // the static impact-scan can't see through the indirection.
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const { listing_ids, action, reason } = req.body as { listing_ids?: string[]; action?: string; reason?: string };
  if (!Array.isArray(listing_ids) || listing_ids.length === 0) return res.status(400).json({ ok: false, error: 'listing_ids_required' });
  if (listing_ids.length > 100) return res.status(400).json({ ok: false, error: 'max_100_listings_per_bulk_action' });
  const patchTemplate = action ? BULK_ACTION_PATCH[action] : undefined;
  if (!patchTemplate) return res.status(400).json({ ok: false, error: 'unknown_action' });
  if (action === 'reject' && !reason?.trim()) {
    return res.status(400).json({ ok: false, error: 'reason_required_for_reject' });
  }

  const patch: Record<string, unknown> = { ...patchTemplate };
  if (action === 'reject' || action === 'flag_review') patch.admin_review_reason = reason?.trim() ?? null;
  const adminUserId = getAdminUserId(req);
  if ('status' in patch) {
    patch.reviewed_by = adminUserId;
    patch.reviewed_at = new Date().toISOString();
  }

  const { data: rows, error: fetchErr } = await repo.fetchListingsForBulkAction(supabase, getTenantId(req), listing_ids);
  if (fetchErr) return res.status(500).json({ ok: false, error: fetchErr.message });
  if (!rows || rows.length === 0) return res.status(404).json({ ok: false, error: 'no_matching_listings' });

  const { error } = await repo.bulkUpdateListings(supabase, rows.map((r) => r.id), patch);
  if (error) return res.status(500).json({ ok: false, error: error.message });

  const toStatus = typeof patch.status === 'string' ? patch.status : null;
  if (toStatus) {
    await Promise.all(
      rows
        .filter((r) => r.status !== toStatus)
        .map((r) => recordStatusHistory(supabase, r.id, 'admin', adminUserId, r.status, toStatus, `admin_bulk_action:${action}`))
    );
  }

  const notifKey = action ? NOTIFY_ACTION[action] : null;
  const isRejected = notifKey === 'notif.marketplace_listing_rejected';
  const isApproved = notifKey === 'notif.marketplace_listing_approved';
  if (isRejected || isApproved) {
    const sellerIds = [...new Set(rows.map((r) => r.seller_user_id))];
    const locales = await bulkGetUserLocales(supabase, sellerIds);
    await Promise.all(
      rows.map((r) => {
        const lc = locales.get(r.seller_user_id);
        const notifType = isRejected ? 'marketplace_listing_rejected' : 'marketplace_listing_approved';
        const title = isRejected
          ? tt('notif.marketplace_listing_rejected.title', lc)
          : tt('notif.marketplace_listing_approved.title', lc);
        const body = isRejected
          ? tt('notif.marketplace_listing_rejected.body', lc, { title: r.title, reason: reason!.trim() })
          : tt('notif.marketplace_listing_approved.body', lc, { title: r.title });
        return notifyUserAsync(
          r.seller_user_id,
          getTenantId(req)!,
          notifType,
          { title, body, data: { type: notifType, listing_id: r.id } },
          supabase
        );
      })
    );
  }

  await emitAdminActivity(req, 'community_marketplace.admin.listing_reviewed', `Admin bulk action: ${action}`, {
    action,
    count: rows.length,
    listing_ids: rows.map((r) => r.id).slice(0, 10),
    reason: reason?.trim() ?? null,
  });

  res.json({ ok: true, updated: rows.length });
});

// ==================== Seller suspension ====================

router.post('/sellers/:userId/suspend', async (req: Request, res: Response) => {
  // impact-allow-no-oasis: emitAdminActivity() below wraps emitOasisEvent —
  // the static impact-scan can't see through the indirection.
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const { userId } = req.params;
  const { reason } = req.body as { reason?: string };
  const tenantId = getTenantId(req);

  const { error: upsertErr } = await repo.upsertSellerSuspension(supabase, {
    seller_user_id: userId, tenant_id: tenantId, suspended_by: getAdminUserId(req), reason: reason?.trim() ?? null,
  });
  if (upsertErr) return res.status(500).json({ ok: false, error: upsertErr.message });

  const { data: rows, error: rowsErr } = await repo.fetchActiveListingsForSeller(supabase, userId, tenantId);
  if (rowsErr) {
    // The suspension record itself already committed above — this only
    // affects whether the seller's currently-active listings also get
    // pulled down. Logged loudly rather than silently reporting
    // listings_suspended:0 as if the seller genuinely had none: an admin
    // relying on that count to confirm a bad actor's listings are hidden
    // would otherwise be told everything is handled when it isn't.
    console.error(`[admin-community-marketplace] active-listings lookup failed while suspending seller=${userId}: ${rowsErr.message}`);
  }

  if (rows && rows.length > 0) {
    await repo.bulkUpdateListings(supabase, rows.map((r) => r.id), { status: 'suspended', requires_admin_review: false });
    await Promise.all(
      rows.map((r) => recordStatusHistory(supabase, r.id, 'admin', getAdminUserId(req), r.status, 'suspended', 'seller_suspended'))
    );
  }

  await emitAdminActivity(req, 'community_marketplace.admin.seller_suspended', 'Admin suspended a seller', {
    seller_user_id: userId,
    listings_suspended: rows?.length ?? 0,
    listings_lookup_failed: !!rowsErr,
    reason: reason?.trim() ?? null,
  });

  res.status(201).json({ ok: true, listings_suspended: rows?.length ?? 0, listings_lookup_failed: !!rowsErr });
});

router.delete('/sellers/:userId/suspend', async (req: Request, res: Response) => {
  // impact-allow-no-oasis: emitAdminActivity() below wraps emitOasisEvent —
  // the static impact-scan can't see through the indirection.
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const { userId } = req.params;
  const { error } = await repo.deleteSellerSuspension(supabase, userId, getTenantId(req));
  if (error) return res.status(500).json({ ok: false, error: error.message });

  // Deliberately does NOT auto-reactivate the seller's suspended listings —
  // an admin lifting a suspension is a separate decision from republishing
  // specific content; use the listings bulk-action ("reactivate") for that.
  await emitAdminActivity(req, 'community_marketplace.admin.seller_unsuspended', 'Admin lifted a seller suspension', {
    seller_user_id: userId,
  });

  res.json({ ok: true });
});

// ==================== GET/PATCH /reports ====================

router.get('/reports', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const { status, limit, offset } = req.query;
  const { data, error, count } = await repo.fetchAdminReportsQueue(supabase, {
    tenantId: getTenantId(req),
    status: status ? String(status) : undefined,
    offset: Number(offset ?? 0),
    limit: Number(limit ?? 50),
  });
  if (error) return res.status(500).json({ ok: false, error: error.message });

  const items = (data ?? []).map((row: any) => ({
    ...row,
    listing_title: row.community_listings?.title ?? null,
    listing_status: row.community_listings?.status ?? null,
    seller_user_id: row.community_listings?.seller_user_id ?? null,
    community_listings: undefined,
  }));

  res.json({ ok: true, items, total: count ?? 0 });
});

router.patch('/reports/:id', async (req: Request, res: Response) => {
  // impact-allow-no-oasis: emitAdminActivity() below wraps emitOasisEvent —
  // the static impact-scan can't see through the indirection.
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const { id } = req.params;
  const allowed = ['status', 'admin_notes'];
  const patch: Record<string, unknown> = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
  if (Object.keys(patch).length === 0) return res.status(400).json({ ok: false, error: 'no_allowed_fields' });

  if (patch.status === 'actioned' || patch.status === 'dismissed') {
    patch.resolved_by = getAdminUserId(req);
    patch.resolved_at = new Date().toISOString();
  }

  const { data, error } = await repo.updateReport(supabase, id, getTenantId(req), patch);
  if (error) return res.status(500).json({ ok: false, error: error.message });

  await emitAdminActivity(req, 'community_marketplace.admin.report_resolved', 'Admin updated a listing report', { report_id: id, patch });

  res.json({ ok: true, report: data });
});

// ==================== GET/PATCH /categories ====================

router.get('/categories', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const { data, error } = await repo.fetchAllCategoriesAdmin(supabase);
  if (error) return res.status(500).json({ ok: false, error: error.message });

  res.json({ ok: true, categories: data ?? [] });
});

router.patch('/categories/:key', async (req: Request, res: Response) => {
  // impact-allow-no-oasis: emitAdminActivity() below wraps emitOasisEvent —
  // the static impact-scan can't see through the indirection.
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const { key } = req.params;
  const allowed = ['display_label', 'is_prohibited', 'requires_verified_provider', 'requires_admin_review_always', 'is_active', 'sort_order'];
  const patch: Record<string, unknown> = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
  if (Object.keys(patch).length === 0) return res.status(400).json({ ok: false, error: 'no_allowed_fields' });

  const { data, error } = await repo.updateCategory(supabase, key, patch);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!data) return res.status(404).json({ ok: false, error: 'category_not_found' });

  await emitAdminActivity(req, 'community_marketplace.admin.category_updated', 'Admin updated a listing category', { key, patch });

  res.json({ ok: true, category: data });
});

export default router;
