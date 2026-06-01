/**
 * VTID-03237 — Video Shop (Vitanaland) gateway slice (V1, backend).
 *
 * A NEW SURFACE over the existing Discover `products` catalog + Universal Cart.
 * It forks nothing: the drawer's "Add to cart" calls the existing
 * /api/v1/universal-cart/items with source_surface='video_shop' (+ attribution);
 * "Buy now with wallet" does NOT exist yet (no checkout bridge — V1.2).
 *
 * Endpoints (mounted at /api/v1/shop-feed):
 *   GET    /health                  — health check.
 *   GET    /videos?cursor=&limit=   — ranked, hydrated vertical feed.
 *   GET    /videos/:id              — single video + primary anchor (deep link / share).
 *   GET    /videos/:id/anchor       — drawer payload (peek): primary anchor + live product.
 *   POST   /videos/:id/events       — funnel event ingestion into shop_video_events (NOT OASIS).
 *   POST   /events/batch            — batched funnel events.
 *   GET    /saved?cursor=&limit=    — caller's saved products.
 *   POST   /saved                   — save a product { product_id, video_id? }.
 *   DELETE /saved/:productId        — unsave.
 *
 * Access control: community-role-only, mirroring the Universal Cart slice
 * (VTID-03213). Non-community sessions get 403 `shop_unavailable_for_role`.
 * Feed reads + event writes use the service-role client (videos/anchors are
 * curated and have no per-user ownership; events are a service-role sink).
 * Saves use the user-JWT client so RLS enforces owner isolation.
 *
 * V1 launch shape: curated/admin videos, single anchor, drawer, add-to-cart,
 * save, share, PDP. Behind a community feature flag.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createUserSupabaseClient } from '../lib/supabase-user';
import { getSupabase } from '../lib/supabase';
import { getBearerToken, getUserContext, getActiveRole } from './universal-cart';

export const VTID = 'VTID-03237';

const COMMUNITY_ROLE = 'community';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const router = Router();

// =============================================================================
// Constants — keep event_type in sync with shop_video_events_type_check in
// 20260607000000_VTID_03237_video_shop_schema.sql.
// =============================================================================

const ALLOWED_EVENT_TYPES = [
  'impression', 'hold_2s', 'anchor_tap', 'drawer_open', 'drawer_expand', 'pdp_view',
  'variant_change', 'add_to_cart', 'buy_now', 'checkout_start', 'purchase',
  'save', 'unsave', 'share', 'drawer_close',
] as const;

/** Product columns hydrated into the feed/drawer payloads. */
const PRODUCT_COLUMNS =
  'id, title, description, brand, category, subcategory, price_cents, currency, ' +
  'compare_at_price_cents, images, affiliate_url, availability, rating, review_count, ' +
  'origin_country, merchant_id, ingredients_primary, health_goals, dietary_tags, is_active';

// =============================================================================
// Helpers
// =============================================================================

/** Combined auth + community-role gate. Sends 401/403 and returns null on failure. */
async function authorizeCommunityCaller(
  req: Request,
  res: Response
): Promise<{ token: string; user_id: string; tenant_id: string | null } | null> {
  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    return null;
  }
  const ctx = await getUserContext(token);
  if (!ctx.ok) {
    res.status(401).json({ ok: false, error: 'UNAUTHENTICATED', detail: ctx.error });
    return null;
  }
  const role = await getActiveRole(ctx.user_id, ctx.tenant_id);
  if (role !== COMMUNITY_ROLE) {
    res.status(403).json({ ok: false, error: 'shop_unavailable_for_role', role });
    return null;
  }
  return { token, user_id: ctx.user_id, tenant_id: ctx.tenant_id };
}

function clampLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/** Opaque offset cursor. V1 feed is a small curated set, so keyset is overkill. */
function decodeCursor(raw: unknown): number {
  if (typeof raw !== 'string' || !raw) return 0;
  try {
    const n = Number(JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))?.offset);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}
function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64');
}

/** Shape a products row into the client product card. */
function shapeProduct(p: any): Record<string, unknown> | null {
  if (!p) return null;
  return {
    id: p.id,
    title: p.title,
    description: p.description ?? null,
    brand: p.brand ?? null,
    category: p.category ?? null,
    subcategory: p.subcategory ?? null,
    price_cents: p.price_cents ?? null,
    currency: p.currency ?? null,
    compare_at_price_cents: p.compare_at_price_cents ?? null,
    images: Array.isArray(p.images) ? p.images : [],
    affiliate_url: p.affiliate_url ?? null,
    availability: p.availability ?? 'unknown',
    in_stock: p.availability === 'in_stock',
    rating: p.rating ?? null,
    review_count: p.review_count ?? null,
    origin_country: p.origin_country ?? null,
    merchant_id: p.merchant_id ?? null,
    ingredients_primary: Array.isArray(p.ingredients_primary) ? p.ingredients_primary : [],
    health_goals: Array.isArray(p.health_goals) ? p.health_goals : [],
    dietary_tags: Array.isArray(p.dietary_tags) ? p.dietary_tags : [],
  };
}

/** Shape a shop_videos row + its primary anchor + hydrated product into a feed item. */
function shapeVideoItem(v: any, anchor: any, product: any): Record<string, unknown> {
  return {
    id: v.id,
    title: v.title ?? null,
    caption: v.caption ?? null,
    creator_id: v.creator_id ?? null,
    playback: {
      video_url: v.video_url,
      poster_url: v.poster_url ?? null,
      thumbnail_url: v.thumbnail_url ?? null,
      duration_ms: v.duration_ms ?? 0,
      aspect_ratio: v.aspect_ratio ?? '9:16',
    },
    primary_anchor: anchor
      ? {
          id: anchor.id,
          label: anchor.label ?? 'Shop now',
          appear_at_ms: anchor.appear_at_ms ?? 0,
          pos_x: anchor.pos_x ?? 0.5,
          pos_y: anchor.pos_y ?? 0.82,
          badge_price_cents: anchor.badge_price_cents ?? null,
          currency: anchor.currency ?? null,
          product: shapeProduct(product),
        }
      : null,
  };
}

/**
 * Resolve the live primary anchor (+ hydrated, purchasable product) for a set of
 * video ids. Returns a map videoId → { anchor, product }. Only anchors whose
 * product is active + in_stock are returned (the pill must be purchasable).
 */
async function loadPrimaryAnchors(
  svc: any,
  videoIds: string[]
): Promise<Map<string, { anchor: any; product: any }>> {
  const out = new Map<string, { anchor: any; product: any }>();
  if (videoIds.length === 0) return out;

  const anchors = await svc
    .from('shop_video_anchors')
    .select('id, video_id, product_id, label, appear_at_ms, pos_x, pos_y, badge_price_cents, currency')
    .in('video_id', videoIds)
    .eq('is_primary', true);
  if (anchors.error || !anchors.data?.length) return out;

  const productIds = [...new Set(anchors.data.map((a: any) => a.product_id))];
  const products = await svc.from('products').select(PRODUCT_COLUMNS).in('id', productIds);
  const productById = new Map<string, any>();
  for (const p of products.data || []) productById.set(p.id, p);

  for (const a of anchors.data) {
    const p = productById.get(a.product_id);
    // Pill is purchasable-only: drop anchors whose product is inactive / OOS.
    if (!p || p.is_active !== true || p.availability !== 'in_stock') continue;
    if (!out.has(a.video_id)) out.set(a.video_id, { anchor: a, product: p });
  }
  return out;
}

/** Best-effort funnel event insert (service-role). Never throws to the caller. */
async function insertEvents(rows: Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return;
  const svc = getSupabase();
  if (!svc) {
    console.error(`[${VTID}] event sink: service-role client unavailable`);
    return;
  }
  const { error } = await svc.from('shop_video_events').insert(rows);
  if (error) console.error(`[${VTID}] shop_video_events insert failed:`, error.message);
}

// =============================================================================
// Request schemas
// =============================================================================

const EventBody = z.object({
  type: z.enum(ALLOWED_EVENT_TYPES),
  session_id: z.string().min(1).max(200),
  anchor_id: z.string().uuid().optional(),
  product_id: z.string().uuid().optional(),
  dwell_ms: z.number().int().nonnegative().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const BatchEventBody = z.object({
  events: z.array(EventBody.extend({ video_id: z.string().uuid() })).min(1).max(100),
});

const SaveBody = z.object({
  product_id: z.string().uuid(),
  video_id: z.string().uuid().optional(),
});

// =============================================================================
// Routes
// =============================================================================

router.get('/health', (_req: Request, res: Response) => {
  return res.status(200).json({ ok: true, vtid: VTID, scope: 'video_shop_v1' });
});

/** GET /videos — ranked, hydrated vertical feed (live videos with a purchasable anchor). */
router.get('/videos', async (req: Request, res: Response) => {
  const id = await authorizeCommunityCaller(req, res);
  if (!id) return;

  const svc = getSupabase();
  if (!svc) return res.status(500).json({ ok: false, error: 'service_unavailable' });

  const limit = clampLimit(req.query.limit);
  const offset = decodeCursor(req.query.cursor);

  // Over-fetch by one to compute next_cursor.
  const videos = await svc
    .from('shop_videos')
    .select('id, title, caption, creator_id, video_url, poster_url, thumbnail_url, duration_ms, aspect_ratio, rank_score, created_at')
    .eq('status', 'active')
    .eq('moderation_status', 'approved')
    .order('rank_score', { ascending: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit); // inclusive → fetches limit+1
  if (videos.error) {
    return res.status(500).json({ ok: false, error: 'feed_lookup_failed', detail: videos.error.message });
  }

  const page = (videos.data || []).slice(0, limit);
  const hasMore = (videos.data || []).length > limit;
  const anchorMap = await loadPrimaryAnchors(svc, page.map((v: any) => v.id));

  // Only surface videos that have a live, purchasable primary anchor.
  const items = page
    .filter((v: any) => anchorMap.has(v.id))
    .map((v: any) => {
      const bound = anchorMap.get(v.id)!;
      return shapeVideoItem(v, bound.anchor, bound.product);
    });

  return res.status(200).json({
    ok: true,
    videos: items,
    next_cursor: hasMore ? encodeCursor(offset + limit) : null,
  });
});

/** GET /videos/:id — single video + primary anchor (deep link / share / refresh). */
router.get('/videos/:id', async (req: Request, res: Response) => {
  const id = await authorizeCommunityCaller(req, res);
  if (!id) return;
  const videoId = req.params.id;

  const svc = getSupabase();
  if (!svc) return res.status(500).json({ ok: false, error: 'service_unavailable' });

  const video = await svc
    .from('shop_videos')
    .select('id, title, caption, creator_id, video_url, poster_url, thumbnail_url, duration_ms, aspect_ratio, status, moderation_status')
    .eq('id', videoId)
    .maybeSingle();
  if (video.error) {
    return res.status(500).json({ ok: false, error: 'video_lookup_failed', detail: video.error.message });
  }
  if (!video.data || video.data.status !== 'active' || video.data.moderation_status !== 'approved') {
    return res.status(404).json({ ok: false, error: 'video_not_found' });
  }

  const anchorMap = await loadPrimaryAnchors(svc, [videoId]);
  const bound = anchorMap.get(videoId);
  return res.status(200).json({
    ok: true,
    video: shapeVideoItem(video.data, bound?.anchor ?? null, bound?.product ?? null),
  });
});

/** GET /videos/:id/anchor — drawer peek payload with LIVE product price/stock. */
router.get('/videos/:id/anchor', async (req: Request, res: Response) => {
  const id = await authorizeCommunityCaller(req, res);
  if (!id) return;
  const videoId = req.params.id;

  const svc = getSupabase();
  if (!svc) return res.status(500).json({ ok: false, error: 'service_unavailable' });

  const anchorMap = await loadPrimaryAnchors(svc, [videoId]);
  const bound = anchorMap.get(videoId);
  if (!bound) {
    // Either no anchor or its product is no longer purchasable.
    return res.status(404).json({ ok: false, error: 'anchor_unavailable' });
  }
  return res.status(200).json({
    ok: true,
    anchor: {
      id: bound.anchor.id,
      label: bound.anchor.label ?? 'Shop now',
      badge_price_cents: bound.anchor.badge_price_cents ?? null,
      currency: bound.anchor.currency ?? null,
      product: shapeProduct(bound.product),
    },
  });
});

/** POST /videos/:id/events — single funnel event. */
router.post('/videos/:id/events', async (req: Request, res: Response) => {
  const id = await authorizeCommunityCaller(req, res);
  if (!id) return;
  const videoId = req.params.id;

  const parsed = EventBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_request',
      detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  const e = parsed.data;
  await insertEvents([{
    video_id: videoId,
    anchor_id: e.anchor_id ?? null,
    user_id: id.user_id,
    session_id: e.session_id,
    event_type: e.type,
    product_id: e.product_id ?? null,
    dwell_ms: e.dwell_ms ?? null,
    metadata: e.metadata ?? {},
  }]);
  return res.status(202).json({ ok: true });
});

/** POST /events/batch — client batches IMPRESSION/HOLD to save battery/network. */
router.post('/events/batch', async (req: Request, res: Response) => {
  const id = await authorizeCommunityCaller(req, res);
  if (!id) return;

  const parsed = BatchEventBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_request',
      detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  const rows = parsed.data.events.map((e) => ({
    video_id: e.video_id,
    anchor_id: e.anchor_id ?? null,
    user_id: id.user_id,
    session_id: e.session_id,
    event_type: e.type,
    product_id: e.product_id ?? null,
    dwell_ms: e.dwell_ms ?? null,
    metadata: e.metadata ?? {},
  }));
  await insertEvents(rows);
  return res.status(202).json({ ok: true, accepted: rows.length });
});

/** GET /saved — caller's saved products (RLS owner-scoped). */
router.get('/saved', async (req: Request, res: Response) => {
  const id = await authorizeCommunityCaller(req, res);
  if (!id) return;

  const limit = clampLimit(req.query.limit);
  const offset = decodeCursor(req.query.cursor);
  const supabase = createUserSupabaseClient(id.token);

  const saved = await supabase
    .from('shop_saved_products')
    .select('id, product_id, video_id, created_at')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit);
  if (saved.error) {
    return res.status(500).json({ ok: false, error: 'saved_lookup_failed', detail: saved.error.message });
  }

  const page = (saved.data || []).slice(0, limit);
  const hasMore = (saved.data || []).length > limit;

  // Hydrate products via service-role (products has no per-user RLS concern here).
  const svc = getSupabase();
  const productIds = [...new Set(page.map((s: any) => s.product_id))];
  const productById = new Map<string, any>();
  if (svc && productIds.length) {
    const products = await svc.from('products').select(PRODUCT_COLUMNS).in('id', productIds);
    for (const p of products.data || []) productById.set(p.id, p);
  }

  return res.status(200).json({
    ok: true,
    saved: page.map((s: any) => ({
      id: s.id,
      product_id: s.product_id,
      video_id: s.video_id ?? null,
      created_at: s.created_at,
      product: shapeProduct(productById.get(s.product_id)),
    })),
    next_cursor: hasMore ? encodeCursor(offset + limit) : null,
  });
});

/** POST /saved — save a product (idempotent on the (user, product) unique index). */
router.post('/saved', async (req: Request, res: Response) => {
  const id = await authorizeCommunityCaller(req, res);
  if (!id) return;

  const parsed = SaveBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_request',
      detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  const body = parsed.data;
  const supabase = createUserSupabaseClient(id.token);

  const inserted = await supabase
    .from('shop_saved_products')
    .upsert(
      { user_id: id.user_id, product_id: body.product_id, video_id: body.video_id ?? null },
      { onConflict: 'user_id,product_id', ignoreDuplicates: true }
    )
    .select('id, product_id, video_id, created_at')
    .maybeSingle();
  if (inserted.error) {
    return res.status(500).json({ ok: false, error: 'save_failed', detail: inserted.error.message });
  }
  return res.status(201).json({ ok: true, saved: inserted.data ?? { product_id: body.product_id, already: true } });
});

/** DELETE /saved/:productId — unsave (RLS owner-scoped). */
router.delete('/saved/:productId', async (req: Request, res: Response) => {
  const id = await authorizeCommunityCaller(req, res);
  if (!id) return;

  const supabase = createUserSupabaseClient(id.token);
  const removed = await supabase
    .from('shop_saved_products')
    .delete()
    .eq('user_id', id.user_id)
    .eq('product_id', req.params.productId);
  if (removed.error) {
    return res.status(500).json({ ok: false, error: 'unsave_failed', detail: removed.error.message });
  }
  return res.status(204).send();
});

export default router;
