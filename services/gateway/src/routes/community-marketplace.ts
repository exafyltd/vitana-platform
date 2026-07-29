/**
 * BOOTSTRAP-COMMUNITY-MARKETPLACE — Chunk 2: user-facing (seller + buyer) API
 * for peer-to-peer classifieds. See supabase/migrations/
 * 20260727090000_bootstrap_community_marketplace.sql for schema/RLS and
 * services/community-marketplace/listing-moderation-check.ts for the v1
 * auto-moderation logic used at create/edit time.
 *
 * Mounted at /api/v1/community-marketplace. Every route is
 * requireAuthWithTenant — this is a tenant-scoped community feature, not a
 * public storefront.
 *
 * Out of scope here (separate chunks): the admin review queue (Chunk 7,
 * its own admin-community-marketplace.ts) and any frontend UI (Chunks 3-6, 8).
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getSupabase } from '../lib/supabase';
import { requireAuthWithTenant, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { emitOasisEvent } from '../services/oasis-event-service';
import type { CicdEventType } from '../types/cicd';
import {
  runModerationCheck,
  ModerationBlockedError,
  type ModerationCategoryInfo,
} from '../services/community-marketplace/listing-moderation-check';

const router = Router();
router.use(requireAuthWithTenant);

const VTID = 'BOOTSTRAP-COMMUNITY-MARKETPLACE';

// Reports on a listing that reach this many non-dismissed submissions
// auto-escalate it into the admin review queue (see POST /listings/:id/reports
// below) — a cheap circuit-breaker so a clearly-bad listing doesn't sit live
// just because no admin has looked yet.
const AUTO_ESCALATE_REPORT_THRESHOLD = 3;

function identity(req: Request) {
  // Non-null: every route on this router runs after requireAuthWithTenant,
  // which rejects the request before a handler ever sees a missing identity.
  return (req as AuthenticatedRequest).identity!;
}

// ==================== Shared row shaping ====================

const PUBLIC_LISTING_COLUMNS =
  'id, tenant_id, seller_user_id, listing_kind, condition, category, subcategory, title, description, images, ' +
  'price_cents, currency, price_on_request, location_text, is_remote_service, delivery_method, ' +
  'requires_verified_provider, status, sold_at, renewed_at, expires_at, view_count, contact_click_count, created_at, updated_at';

const OWNER_ONLY_COLUMNS =
  'auto_check_result, auto_check_reasons, requires_admin_review, admin_review_reason, admin_notes, reviewed_at';

function serializeListing(row: any, opts: { isOwner: boolean; seller?: any }) {
  const base: Record<string, unknown> = {
    id: row.id,
    seller_user_id: row.seller_user_id,
    listing_kind: row.listing_kind,
    condition: row.condition,
    category: row.category,
    subcategory: row.subcategory,
    title: row.title,
    description: row.description,
    images: row.images ?? [],
    price_cents: row.price_cents,
    currency: row.currency,
    price_on_request: row.price_on_request,
    location_text: row.location_text,
    is_remote_service: row.is_remote_service,
    delivery_method: row.delivery_method,
    requires_verified_provider: row.requires_verified_provider,
    status: row.status,
    sold_at: row.sold_at,
    renewed_at: row.renewed_at,
    expires_at: row.expires_at,
    view_count: row.view_count,
    contact_click_count: row.contact_click_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (opts.seller) {
    base.seller = {
      user_id: opts.seller.user_id,
      display_name: opts.seller.display_name ?? opts.seller.full_name ?? null,
      avatar_url: opts.seller.avatar_url ?? null,
      vitana_id: opts.seller.vitana_id ?? null,
      verification_status: opts.seller.verification_status ?? null,
    };
  }
  if (opts.isOwner) {
    base.auto_check_result = row.auto_check_result;
    base.auto_check_reasons = row.auto_check_reasons ?? [];
    base.requires_admin_review = row.requires_admin_review;
    base.admin_review_reason = row.admin_review_reason;
    base.reviewed_at = row.reviewed_at;
  }
  return base;
}

export async function recordStatusHistory(
  supabase: ReturnType<typeof getSupabase>,
  listingId: string,
  actorType: 'seller' | 'admin' | 'system',
  actorUserId: string | null,
  fromStatus: string | null,
  toStatus: string,
  reason: string
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

async function fetchCategory(
  supabase: ReturnType<typeof getSupabase>,
  key: string
): Promise<ModerationCategoryInfo | null> {
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

// ==================== GET /categories ====================

router.get('/categories', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const listingKind = typeof req.query.listing_kind === 'string' ? req.query.listing_kind : undefined;

  let query = supabase
    .from('community_listing_categories')
    .select('key, listing_kind, display_label, parent_key, sort_order')
    .eq('is_active', true)
    .eq('is_prohibited', false)
    .order('sort_order', { ascending: true });

  if (listingKind === 'product' || listingKind === 'service') {
    query = query.in('listing_kind', [listingKind, 'both']);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, categories: data ?? [] });
});

// ==================== GET /listings (browse/search) ====================

const BrowseQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  category: z.string().max(64).optional(),
  subcategory: z.string().max(64).optional(),
  listing_kind: z.enum(['product', 'service']).optional(),
  condition: z.enum(['new', 'like_new', 'good', 'fair', 'used']).optional(),
  delivery_method: z.enum(['pickup', 'shipping', 'both', 'not_applicable']).optional(),
  min_price_cents: z.coerce.number().int().min(0).optional(),
  max_price_cents: z.coerce.number().int().min(0).optional(),
  sort: z.enum(['newest', 'price_asc', 'price_desc']).default('newest'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

router.get('/listings', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const parsed = BrowseQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_QUERY', details: parsed.error.flatten() });
  const p = parsed.data;
  const tenantId = identity(req).tenant_id!;
  const viewerId = identity(req).user_id;

  const { data: blocks } = await supabase
    .from('community_listing_seller_blocks')
    .select('blocked_seller_id')
    .eq('viewer_user_id', viewerId);
  const blockedIds = (blocks ?? []).map((b: any) => b.blocked_seller_id);

  let query = supabase
    .from(`community_listings`)
    .select(PUBLIC_LISTING_COLUMNS, { count: 'exact' })
    .eq('tenant_id', tenantId)
    .eq('status', 'active');

  if (blockedIds.length > 0) query = query.not('seller_user_id', 'in', `(${blockedIds.join(',')})`);
  if (p.category) query = query.eq('category', p.category);
  if (p.subcategory) query = query.eq('subcategory', p.subcategory);
  if (p.listing_kind) query = query.eq('listing_kind', p.listing_kind);
  if (p.condition) query = query.eq('condition', p.condition);
  if (p.delivery_method) query = query.eq('delivery_method', p.delivery_method);
  if (p.min_price_cents !== undefined) query = query.gte('price_cents', p.min_price_cents);
  if (p.max_price_cents !== undefined) query = query.lte('price_cents', p.max_price_cents);
  if (p.q) query = query.textSearch('search_text', p.q, { type: 'websearch' });

  if (p.sort === 'price_asc') query = query.order('price_cents', { ascending: true, nullsFirst: false });
  else if (p.sort === 'price_desc') query = query.order('price_cents', { ascending: false, nullsFirst: false });
  else query = query.order('created_at', { ascending: false });

  query = query.range(p.offset, p.offset + p.limit - 1);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ ok: false, error: error.message });

  res.json({
    ok: true,
    listings: (data ?? []).map((row: any) => serializeListing(row, { isOwner: false })),
    meta: { total_count: count ?? 0, limit: p.limit, offset: p.offset },
  });
});

// ==================== GET /my/listings (seller dashboard) ====================

router.get('/my/listings', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const statusFilter = typeof req.query.status === 'string' ? req.query.status : undefined;
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '20'), 10) || 20, 1), 50);
  const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);

  let query = supabase
    .from('community_listings')
    .select(`${PUBLIC_LISTING_COLUMNS}, ${OWNER_ONLY_COLUMNS}`, { count: 'exact' })
    .eq('seller_user_id', identity(req).user_id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (statusFilter) query = query.eq('status', statusFilter);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ ok: false, error: error.message });

  res.json({
    ok: true,
    listings: (data ?? []).map((row: any) => serializeListing(row, { isOwner: true })),
    meta: { total_count: count ?? 0, limit, offset },
  });
});

// ==================== GET /listings/:id ====================

router.get('/listings/:id', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const viewerId = identity(req).user_id;
  const { data: row, error } = await supabase
    .from('community_listings')
    .select(`${PUBLIC_LISTING_COLUMNS}, ${OWNER_ONLY_COLUMNS}`)
    .eq('id', req.params.id)
    .eq('tenant_id', identity(req).tenant_id!)
    .maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!row) return res.status(404).json({ ok: false, error: 'listing_not_found' });

  const isOwner = row.seller_user_id === viewerId;
  if (!isOwner) {
    if (!['active', 'paused', 'sold'].includes(row.status)) return res.status(404).json({ ok: false, error: 'listing_not_found' });
    const { data: block } = await supabase
      .from('community_listing_seller_blocks')
      .select('id')
      .eq('viewer_user_id', viewerId)
      .eq('blocked_seller_id', row.seller_user_id)
      .maybeSingle();
    if (block) return res.status(404).json({ ok: false, error: 'listing_not_found' });
  }

  const { data: seller } = await supabase
    .from('profiles')
    .select('user_id, display_name, full_name, avatar_url, vitana_id, verification_status')
    .eq('user_id', row.seller_user_id)
    .maybeSingle();

  if (!isOwner && row.status === 'active') {
    void (async () => {
      try {
        await supabase.from('community_listings').update({ view_count: row.view_count + 1 }).eq('id', row.id);
      } catch { /* non-fatal */ }
    })();
  }

  res.json({ ok: true, listing: serializeListing(row, { isOwner, seller }) });
});

// ==================== POST /listings (create) ====================

const CreateListingSchema = z.object({
  listing_kind: z.enum(['product', 'service']),
  condition: z.enum(['new', 'like_new', 'good', 'fair', 'used']).optional(),
  category: z.string().min(1).max(64),
  subcategory: z.string().max(64).optional(),
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(10).max(4000),
  images: z.array(z.string().url()).max(10).default([]),
  price_cents: z.coerce.number().int().min(0).optional(),
  currency: z.string().length(3).optional(),
  price_on_request: z.boolean().default(false),
  location_text: z.string().max(200).optional(),
  is_remote_service: z.boolean().default(false),
  delivery_method: z.enum(['pickup', 'shipping', 'both', 'not_applicable']).default('not_applicable'),
});

router.post('/listings', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const parsed = CreateListingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_INPUT', details: parsed.error.flatten() });
  const p = parsed.data;

  if (!p.price_on_request && (p.price_cents === undefined || !p.currency)) {
    return res.status(400).json({ ok: false, error: 'price_cents_and_currency_required_unless_price_on_request' });
  }

  const category = await fetchCategory(supabase, p.category);
  if (!category) return res.status(400).json({ ok: false, error: 'invalid_category' });

  const userId = identity(req).user_id;
  const tenantId = identity(req).tenant_id!;

  // BOOTSTRAP-COMMUNITY-MARKETPLACE (Chunk 7): a seller suspended by an admin
  // (see admin-community-marketplace.ts POST /sellers/:userId/suspend) can't
  // create new listings — checked here rather than via RLS since this route
  // uses the service-role client throughout.
  const { data: suspension } = await supabase
    .from('community_marketplace_seller_suspensions')
    .select('seller_user_id')
    .eq('seller_user_id', userId)
    .maybeSingle();
  if (suspension) return res.status(403).json({ ok: false, error: 'seller_suspended' });

  const { data: profile } = await supabase.from('profiles').select('verification_status').eq('user_id', userId).maybeSingle();

  let moderation;
  try {
    moderation = runModerationCheck({
      title: p.title,
      description: p.description,
      category,
      sellerVerificationStatus: profile?.verification_status ?? null,
    });
  } catch (e: any) {
    if (e instanceof ModerationBlockedError) return res.status(400).json({ ok: false, error: e.reasonCode, message: e.message });
    throw e;
  }

  const { data: inserted, error } = await supabase
    .from('community_listings')
    .insert({
      tenant_id: tenantId,
      seller_user_id: userId,
      listing_kind: p.listing_kind,
      condition: p.condition ?? null,
      category: p.category,
      subcategory: p.subcategory ?? null,
      title: p.title,
      description: p.description,
      images: p.images,
      price_cents: p.price_on_request ? null : p.price_cents,
      currency: p.price_on_request ? null : p.currency,
      price_on_request: p.price_on_request,
      location_text: p.location_text ?? null,
      is_remote_service: p.is_remote_service,
      delivery_method: p.delivery_method,
      requires_verified_provider: moderation.requires_verified_provider,
      status: moderation.initial_status,
      auto_check_result: moderation.auto_check_result,
      auto_check_reasons: moderation.auto_check_reasons,
      requires_admin_review: moderation.requires_admin_review,
      admin_review_reason: moderation.requires_admin_review_reason,
    })
    .select(`${PUBLIC_LISTING_COLUMNS}, ${OWNER_ONLY_COLUMNS}`)
    .single();
  if (error) return res.status(500).json({ ok: false, error: error.message });

  await recordStatusHistory(supabase, inserted.id, 'system', userId, null, moderation.initial_status, 'listing_created');
  await emitOasisEvent({
    vtid: VTID,
    type: 'community_marketplace.listing.created',
    source: 'gateway',
    status: 'info',
    message: 'Community listing created',
    payload: {
      listing_id: inserted.id,
      tenant_id: tenantId,
      seller_user_id: userId,
      requires_admin_review: moderation.requires_admin_review,
    },
  });

  res.status(201).json({ ok: true, listing: serializeListing(inserted, { isOwner: true }) });
});

// ==================== PATCH /listings/:id (edit own) ====================

const EditListingSchema = CreateListingSchema.partial().omit({ listing_kind: true });

router.patch('/listings/:id', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const parsed = EditListingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_INPUT', details: parsed.error.flatten() });
  const p = parsed.data;

  const userId = identity(req).user_id;
  const { data: existing, error: fetchErr } = await supabase
    .from('community_listings')
    .select('*')
    .eq('id', req.params.id)
    .eq('seller_user_id', userId)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ ok: false, error: fetchErr.message });
  if (!existing) return res.status(404).json({ ok: false, error: 'listing_not_found' });
  if (['sold', 'removed'].includes(existing.status)) {
    return res.status(409).json({ ok: false, error: 'listing_not_editable', message: `Cannot edit a listing with status "${existing.status}".` });
  }

  const merged = {
    category: p.category ?? existing.category,
    title: p.title ?? existing.title,
    description: p.description ?? existing.description,
  };
  const contentChanged = p.category !== undefined || p.title !== undefined || p.description !== undefined;

  const update: Record<string, unknown> = {};
  for (const key of ['subcategory', 'condition', 'images', 'location_text', 'is_remote_service', 'delivery_method'] as const) {
    if (p[key] !== undefined) update[key] = p[key];
  }
  if (p.category !== undefined) update.category = p.category;
  if (p.title !== undefined) update.title = p.title;
  if (p.description !== undefined) update.description = p.description;

  const priceOnRequest = p.price_on_request ?? existing.price_on_request;
  if (p.price_on_request !== undefined || p.price_cents !== undefined || p.currency !== undefined) {
    if (priceOnRequest) {
      update.price_on_request = true;
      update.price_cents = null;
      update.currency = null;
    } else {
      const priceCents = p.price_cents ?? existing.price_cents;
      const currency = p.currency ?? existing.currency;
      if (priceCents === null || priceCents === undefined || !currency) {
        return res.status(400).json({ ok: false, error: 'price_cents_and_currency_required_unless_price_on_request' });
      }
      update.price_on_request = false;
      update.price_cents = priceCents;
      update.currency = currency;
    }
  }

  let statusOverride: string | null = null;
  if (contentChanged) {
    const category = await fetchCategory(supabase, merged.category);
    if (!category) return res.status(400).json({ ok: false, error: 'invalid_category' });

    const { data: profile } = await supabase.from('profiles').select('verification_status').eq('user_id', userId).maybeSingle();

    let moderation;
    try {
      moderation = runModerationCheck({
        title: merged.title,
        description: merged.description,
        category,
        sellerVerificationStatus: profile?.verification_status ?? null,
      });
    } catch (e: any) {
      if (e instanceof ModerationBlockedError) return res.status(400).json({ ok: false, error: e.reasonCode, message: e.message });
      throw e;
    }

    update.requires_verified_provider = moderation.requires_verified_provider;
    update.auto_check_result = moderation.auto_check_result;
    update.auto_check_reasons = moderation.auto_check_reasons;
    update.requires_admin_review = moderation.requires_admin_review;
    update.admin_review_reason = moderation.requires_admin_review_reason;

    if (moderation.requires_admin_review && existing.status === 'active') {
      statusOverride = 'draft';
      update.status = 'draft';
    }
  }

  const { data: updated, error } = await supabase
    .from('community_listings')
    .update(update)
    .eq('id', existing.id)
    .select(`${PUBLIC_LISTING_COLUMNS}, ${OWNER_ONLY_COLUMNS}`)
    .single();
  if (error) return res.status(500).json({ ok: false, error: error.message });

  if (statusOverride) {
    await recordStatusHistory(supabase, existing.id, 'system', userId, existing.status, statusOverride, 're_review_after_edit');
  }

  await emitOasisEvent({
    vtid: VTID,
    type: 'community_marketplace.listing.updated',
    source: 'gateway',
    status: 'info',
    message: 'Community listing updated',
    payload: { listing_id: existing.id, seller_user_id: userId, re_review_triggered: Boolean(statusOverride) },
  });

  res.json({ ok: true, listing: serializeListing(updated, { isOwner: true }) });
});

// ==================== POST /listings/:id/status (seller lifecycle) ====================

const StatusActionSchema = z.object({
  action: z.enum(['pause', 'activate', 'mark_sold', 'remove', 'renew']),
});

const ALLOWED_FROM: Record<string, string[]> = {
  pause: ['active'],
  activate: ['paused'],
  mark_sold: ['active', 'paused'],
  remove: ['draft', 'active', 'paused'],
  renew: ['active', 'paused'],
};
const TO_STATUS: Record<string, string | null> = {
  pause: 'paused',
  activate: 'active',
  mark_sold: 'sold',
  remove: 'removed',
  renew: null, // renew doesn't change status, just expires_at
};

router.post('/listings/:id/status', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const parsed = StatusActionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_INPUT', details: parsed.error.flatten() });
  const { action } = parsed.data;

  const userId = identity(req).user_id;
  const { data: existing, error: fetchErr } = await supabase
    .from('community_listings')
    .select('id, status, seller_user_id')
    .eq('id', req.params.id)
    .eq('seller_user_id', userId)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ ok: false, error: fetchErr.message });
  if (!existing) return res.status(404).json({ ok: false, error: 'listing_not_found' });

  if (!ALLOWED_FROM[action].includes(existing.status)) {
    return res.status(409).json({
      ok: false,
      error: 'invalid_status_transition',
      message: `Cannot "${action}" a listing with status "${existing.status}".`,
    });
  }

  const update: Record<string, unknown> = {};
  const toStatus = TO_STATUS[action];
  if (toStatus) update.status = toStatus;
  if (action === 'mark_sold') update.sold_at = new Date().toISOString();
  if (action === 'renew') {
    update.renewed_at = new Date().toISOString();
    update.expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  }

  const { data: updated, error } = await supabase
    .from('community_listings')
    .update(update)
    .eq('id', existing.id)
    .select(`${PUBLIC_LISTING_COLUMNS}, ${OWNER_ONLY_COLUMNS}`)
    .single();
  if (error) return res.status(500).json({ ok: false, error: error.message });

  // action === 'renew' skips this: it only touches expires_at/renewed_at, not
  // `status`, and is a routine seller self-service action rather than a
  // state transition worth the global timeline.
  if (toStatus) {
    await recordStatusHistory(supabase, existing.id, 'seller', userId, existing.status, toStatus, `seller_action:${action}`);
    await emitOasisEvent({
      vtid: VTID,
      type: 'community_marketplace.listing.status_changed',
      source: 'gateway',
      status: 'info',
      message: `Community listing ${action}`,
      payload: { listing_id: existing.id, action, from_status: existing.status, to_status: toStatus },
    });
  }

  res.json({ ok: true, listing: serializeListing(updated, { isOwner: true }) });
});

// ==================== POST /listings/:id/contact-click ====================

router.post('/listings/:id/contact-click', async (req: Request, res: Response) => {
  // impact-allow-no-oasis: contact_click_count is an analytics counter (same
  // category as view_count above) — CLAUDE.md's OASIS taxonomy explicitly
  // excludes telemetry.* from the event log.
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const viewerId = identity(req).user_id;
  const { data: row, error } = await supabase
    .from('community_listings')
    .select('id, seller_user_id, status, contact_click_count')
    .eq('id', req.params.id)
    .eq('tenant_id', identity(req).tenant_id!)
    .in('status', ['active', 'paused'])
    .maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!row) return res.status(404).json({ ok: false, error: 'listing_not_found' });

  const { data: seller } = await supabase
    .from('profiles')
    .select('user_id, display_name, vitana_id')
    .eq('user_id', row.seller_user_id)
    .maybeSingle();
  if (!seller) return res.status(404).json({ ok: false, error: 'seller_not_found' });

  if (row.seller_user_id !== viewerId) {
    await supabase.from('community_listings').update({ contact_click_count: row.contact_click_count + 1 }).eq('id', row.id);
  }

  res.json({
    ok: true,
    seller: { user_id: seller.user_id, display_name: seller.display_name, vitana_id: seller.vitana_id },
  });
});

// ==================== POST /listings/:id/reports ====================

const ReportSchema = z.object({
  report_reason: z.enum(['prohibited_item', 'misleading', 'counterfeit', 'spam', 'offensive', 'scam', 'other']),
  report_note: z.string().max(2000).optional(),
});

router.post('/listings/:id/reports', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const parsed = ReportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_INPUT', details: parsed.error.flatten() });
  const p = parsed.data;

  const reporterId = identity(req).user_id;
  const tenantId = identity(req).tenant_id!;

  const { data: listing } = await supabase
    .from('community_listings')
    .select('id, seller_user_id, status, requires_admin_review')
    .eq('id', req.params.id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (!listing) return res.status(404).json({ ok: false, error: 'listing_not_found' });
  if (listing.seller_user_id === reporterId) return res.status(400).json({ ok: false, error: 'cannot_report_own_listing' });

  const { data: report, error } = await supabase
    .from('community_listing_reports')
    .insert({ listing_id: listing.id, reporter_user_id: reporterId, tenant_id: tenantId, report_reason: p.report_reason, report_note: p.report_note ?? null })
    .select('id')
    .single();
  if (error) {
    if ((error as any).code === '23505') return res.status(409).json({ ok: false, error: 'already_reported' });
    return res.status(500).json({ ok: false, error: error.message });
  }

  const { count } = await supabase
    .from('community_listing_reports')
    .select('id', { count: 'exact', head: true })
    .eq('listing_id', listing.id)
    .neq('status', 'dismissed');

  if ((count ?? 0) >= AUTO_ESCALATE_REPORT_THRESHOLD && !listing.requires_admin_review) {
    const update: Record<string, unknown> = { requires_admin_review: true, admin_review_reason: 'auto_escalated_reports' };
    if (listing.status === 'active') update.status = 'draft';
    await supabase.from('community_listings').update(update).eq('id', listing.id);
    if (update.status) await recordStatusHistory(supabase, listing.id, 'system', null, listing.status, 'draft', 'auto_escalated_reports');
    await emitOasisEvent({
      vtid: VTID,
      type: 'community_marketplace.listing.auto_escalated',
      source: 'gateway',
      status: 'warning',
      message: 'Community listing auto-escalated after report threshold',
      payload: { listing_id: listing.id, report_count: count },
    });
  }

  res.status(201).json({ ok: true, report_id: report.id });
});

// ==================== Seller blocks ====================

router.get('/seller-blocks', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const { data, error } = await supabase
    .from('community_listing_seller_blocks')
    .select('id, blocked_seller_id, reason, created_at, profiles:blocked_seller_id(display_name, vitana_id)')
    .eq('viewer_user_id', identity(req).user_id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ ok: false, error: error.message });

  res.json({
    ok: true,
    blocks: (data ?? []).map((b: any) => ({
      id: b.id,
      blocked_seller_id: b.blocked_seller_id,
      blocked_seller_display_name: b.profiles?.display_name ?? null,
      blocked_seller_vitana_id: b.profiles?.vitana_id ?? null,
      reason: b.reason,
      created_at: b.created_at,
    })),
  });
});

const CreateBlockSchema = z.object({
  blocked_seller_id: z.string().uuid(),
  reason: z.string().max(500).optional(),
});

router.post('/seller-blocks', async (req: Request, res: Response) => {
  // impact-allow-no-oasis: a personal, per-viewer visibility preference
  // (scoped to this feature only, see the table's own doc comment) — not a
  // platform-wide state transition worth the global OASIS timeline.
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const parsed = CreateBlockSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_INPUT', details: parsed.error.flatten() });
  const p = parsed.data;
  const viewerId = identity(req).user_id;

  if (p.blocked_seller_id === viewerId) return res.status(400).json({ ok: false, error: 'cannot_block_self' });

  const { data, error } = await supabase
    .from('community_listing_seller_blocks')
    .upsert(
      { viewer_user_id: viewerId, blocked_seller_id: p.blocked_seller_id, tenant_id: identity(req).tenant_id!, reason: p.reason ?? null },
      { onConflict: 'viewer_user_id,blocked_seller_id' }
    )
    .select('id')
    .single();
  if (error) return res.status(500).json({ ok: false, error: error.message });

  res.status(201).json({ ok: true, block_id: data.id });
});

router.delete('/seller-blocks/:blockedSellerId', async (req: Request, res: Response) => {
  // impact-allow-no-oasis: reverses the same personal preference as
  // POST /seller-blocks above — same reasoning applies.
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const { error } = await supabase
    .from('community_listing_seller_blocks')
    .delete()
    .eq('viewer_user_id', identity(req).user_id)
    .eq('blocked_seller_id', req.params.blockedSellerId);
  if (error) return res.status(500).json({ ok: false, error: error.message });

  res.json({ ok: true });
});

export default router;
