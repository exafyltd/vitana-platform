/**
 * VTID-03213 — Universal Cart gateway slice (Phase 1).
 *
 * Endpoints (mounted at /api/v1/universal-cart):
 *   POST   /                      — Get-or-create the caller's active universal_cart.
 *   GET    /                      — Read active cart with active items.
 *   POST   /items                 — Add an item (or bump quantity if product already in cart).
 *   PATCH  /items/:itemId         — Update quantity / metadata of an active item.
 *   DELETE /items/:itemId         — Soft-remove an item (status='removed').
 *   POST   /items/:itemId/complete — Mark item completed (callback from the per-item flow).
 *   GET    /events                — Read recent events for the caller's active cart.
 *   GET    /health                — Health check.
 *
 * Scope (strict, per handoff):
 *   - Reads / writes only `universal_carts`, `universal_cart_items`, `universal_cart_events`.
 *   - Does NOT touch Lovable-side `cart_items`, `checkout_sessions`, `cj_*`, `vouchers`,
 *     `business_packages`, `user_wallets`, `wallet_credits`, or any other ghost commerce table.
 *   - No checkout, no Stripe, no wallet waterfall, no autopilot bridge, no matchmaking.
 *
 * Access control:
 *   - Community-role-only. Non-community sessions get HTTP 403 with `error: 'cart_unavailable_for_role'`.
 *   - Role is read from `user_tenants.active_role` via the service-role client.
 *   - Cart + cart_items mutations use the user-JWT-scoped client so RLS enforces owner isolation.
 *   - cart_events INSERTs use the service-role client (RLS blocks `authenticated` writes; audit
 *     emission is the gateway's responsibility).
 *
 * Conventions mirrored from existing routes (user-preferences.ts, locations.ts) and middleware
 * (require-tenant-admin.ts):
 *   - getBearerToken / getUserContext via me_context RPC.
 *   - createUserSupabaseClient(token) for RLS-evaluated work.
 *   - getSupabase() for service-role audit writes.
 *   - All responses shaped as { ok: boolean, error?: string, ... }.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createUserSupabaseClient } from '../lib/supabase-user';
import { getSupabase } from '../lib/supabase';

export const VTID = 'VTID-03213';

// =============================================================================
// Constants — keep in sync with supabase/migrations/20260605000000_VTID_03186_universal_cart_schema.sql
// =============================================================================

/** item_type CHECK: must match cart_items_item_type_check. */
const ALLOWED_ITEM_TYPES = ['supplement', 'partner_product'] as const;

/**
 * source_surface CHECK: must match cart_items_source_surface_check. NULL is also allowed.
 * 'video_shop' added in VTID-03237 (Video Shop) — kept in sync with the widened
 * CHECK in 20260607000000_VTID_03237_video_shop_schema.sql.
 */
const ALLOWED_SOURCE_SURFACES = ['web', 'mobile', 'voice', 'autopilot', 'community', 'video_shop'] as const;

/**
 * Whitelist of keys permitted inside `universal_cart_events.event_payload`.
 * The PRIVACY RULE on the schema COMMENT says payloads must NOT contain prices,
 * full product descriptions, or user-identifying strings — only ids and minimal
 * structural fields. Enforce at write time.
 */
const ALLOWED_EVENT_PAYLOAD_KEYS = new Set([
  'cart_item_id',
  'product_id',
  'quantity_before',
  'quantity_after',
  'source_surface',
  'source_ref',
  'removal_reason',
]);

/** Soft cap on event-payload string fields to prevent accidental PII leakage via metadata blob. */
const EVENT_PAYLOAD_STRING_MAX = 200;

const COMMUNITY_ROLE = 'community';

const router = Router();

// =============================================================================
// Helpers
// =============================================================================

/** Extract Bearer token from the Authorization header. */
export function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7);
}

export type UserContext =
  | { ok: true; tenant_id: string | null; user_id: string }
  | { ok: false; error: string };

/**
 * Resolve user_id / tenant_id from the caller's JWT via the me_context RPC.
 * Mirrors the pattern in user-preferences.ts.
 */
export async function getUserContext(token: string): Promise<UserContext> {
  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('me_context');
    if (error) return { ok: false, error: error.message };
    const user_id = (data?.user_id || data?.id) as string | undefined;
    if (!user_id) return { ok: false, error: 'me_context returned no user_id' };
    return {
      ok: true,
      tenant_id: (data?.tenant_id as string | null | undefined) ?? null,
      user_id,
    };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'me_context call failed' };
  }
}

/**
 * Resolve the caller's active_role in the given tenant.
 * Uses the service-role client so the lookup is consistent regardless of RLS on
 * `user_tenants` (avoids hiding the role from the very query that gates the route).
 *
 * If tenant_id is null we still proceed — the route returns the standard 403 since
 * active_role can't be resolved without a tenant context.
 */
export async function getActiveRole(
  user_id: string,
  tenant_id: string | null
): Promise<string | null> {
  if (!tenant_id) return null;
  const supabase = getSupabase();
  if (!supabase) {
    console.error(`[${VTID}] active-role lookup: service-role client unavailable`);
    return null;
  }
  const { data, error } = await supabase
    .from('user_tenants')
    .select('active_role')
    .eq('user_id', user_id)
    .eq('tenant_id', tenant_id)
    .maybeSingle();
  if (error) {
    console.error(`[${VTID}] active-role lookup error:`, error.message);
    return null;
  }
  return (data?.active_role as string | undefined) ?? null;
}

/**
 * Standardized 403 response for non-community sessions.
 */
function denyForRole(res: Response, callerRole: string | null): Response {
  return res.status(403).json({
    ok: false,
    error: 'cart_unavailable_for_role',
    role: callerRole, // for client-side diagnostics; not PII
  });
}

/**
 * Combined auth + role gate. Returns the resolved identity on success, or sends
 * a 401/403 response and returns null so callers can early-exit.
 */
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
    denyForRole(res, role);
    return null;
  }
  return { token, user_id: ctx.user_id, tenant_id: ctx.tenant_id };
}

/**
 * Sanitize event_payload to the whitelist + length cap. Drops unknown keys silently;
 * truncates string values; preserves number / boolean values; coerces unknown nested
 * structures to a JSON-stringified, truncated form (never recurses).
 */
export function sanitizeEventPayload(input: Record<string, unknown> | undefined | null): Record<string, unknown> {
  if (!input || typeof input !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!ALLOWED_EVENT_PAYLOAD_KEYS.has(key)) continue;
    if (raw === null || raw === undefined) continue;
    if (typeof raw === 'string') {
      out[key] = raw.length > EVENT_PAYLOAD_STRING_MAX
        ? raw.slice(0, EVENT_PAYLOAD_STRING_MAX)
        : raw;
    } else if (typeof raw === 'number' || typeof raw === 'boolean') {
      out[key] = raw;
    } else {
      // Last-resort coerce; truncate aggressively.
      const s = JSON.stringify(raw);
      out[key] = (s || '').slice(0, EVENT_PAYLOAD_STRING_MAX);
    }
  }
  return out;
}

/**
 * Emit one row into universal_cart_events using the service-role client.
 * Audit emission is best-effort: a failed insert is logged but does NOT fail
 * the user-facing mutation that just succeeded against universal_cart_items.
 * (We accept brief audit gaps over breaking the cart UX; future ops can detect
 * gaps by joining cart_items against cart_events.)
 */
export async function emitCartEvent(args: {
  cart_id: string;
  user_id: string;
  event_type: string;
  event_payload?: Record<string, unknown>;
}): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) {
    console.error(`[${VTID}] cart event drop (${args.event_type}): service-role client unavailable`);
    return;
  }
  const { error } = await supabase
    .from('universal_cart_events')
    .insert({
      cart_id: args.cart_id,
      user_id: args.user_id,
      event_type: args.event_type,
      event_payload: sanitizeEventPayload(args.event_payload),
    });
  if (error) {
    console.error(
      `[${VTID}] cart event insert failed (${args.event_type}, cart ${args.cart_id}):`,
      error.message
    );
  }
}

function isNoRowsError(error: any): boolean {
  return error?.code === 'PGRST116';
}

function isUniqueViolation(error: any): boolean {
  return error?.code === '23505';
}

// =============================================================================
// Request schemas
// =============================================================================

const AddItemBody = z.object({
  product_id: z.string().uuid(),
  item_type: z.enum(ALLOWED_ITEM_TYPES),
  quantity: z.number().positive().default(1),
  source_surface: z.enum(ALLOWED_SOURCE_SURFACES).optional(),
  source_ref: z.string().max(200).optional(),
  merchant_id: z.string().uuid().optional(),
  unit_price_cents_snapshot: z.number().int().nonnegative().optional(),
  currency_snapshot: z.string().length(3).optional(),
  autopilot_rec_id: z.string().uuid().optional(),
  // VTID-03237 — Video Shop attribution. Structured companions to source_ref;
  // copied onto product_orders at order time by the future checkout bridge.
  source_video_id: z.string().uuid().optional(),
  source_creator_id: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const PatchItemBody = z.object({
  quantity: z.number().positive().optional(),
  metadata: z.record(z.unknown()).optional(),
}).refine(
  (b) => b.quantity !== undefined || b.metadata !== undefined,
  { message: 'At least one of `quantity` or `metadata` must be provided.' }
);

// =============================================================================
// Routes
// =============================================================================

/** GET /health — sanity check; no auth needed. */
router.get('/health', (_req: Request, res: Response) => {
  return res.status(200).json({ ok: true, vtid: VTID, scope: 'universal_cart_phase_1' });
});

/**
 * POST / — Get-or-create the caller's active universal_cart.
 *
 * One active cart per user is enforced by the partial-unique index
 * `universal_carts_one_active_per_user`. We attempt insert; on conflict we
 * SELECT the existing row.
 *
 * Emits `cart.created` on actual create (not on no-op fetch).
 */
router.post('/', async (req: Request, res: Response) => {
  const id = await authorizeCommunityCaller(req, res);
  if (!id) return;

  const supabase = createUserSupabaseClient(id.token);

  // Look up an existing active cart first to keep the response shape consistent
  // and avoid emitting cart.created on every POST.
  const existing = await supabase
    .from('universal_carts')
    .select('*')
    .eq('user_id', id.user_id)
    .eq('status', 'active')
    .maybeSingle();

  if (existing.data) {
    return res.status(200).json({ ok: true, cart: existing.data, created: false });
  }
  if (existing.error && existing.error.code && !isNoRowsError(existing.error)) {
    return res.status(500).json({
      ok: false,
      error: 'cart_lookup_failed',
      detail: existing.error.message,
    });
  }

  // Best-effort source_context for diagnostics; capped + sanitized.
  const sourceContext =
    typeof req.body?.source_context === 'string'
      ? String(req.body.source_context).slice(0, 200)
      : null;

  const created = await supabase
    .from('universal_carts')
    .insert({
      user_id: id.user_id,
      tenant_id: id.tenant_id,
      status: 'active',
      source_context: sourceContext,
      metadata: {},
    })
    .select('*')
    .single();

  if (created.error && isUniqueViolation(created.error)) {
    const racedExisting = await supabase
      .from('universal_carts')
      .select('*')
      .eq('user_id', id.user_id)
      .eq('status', 'active')
      .maybeSingle();

    if (racedExisting.data) {
      return res.status(200).json({ ok: true, cart: racedExisting.data, created: false });
    }
    if (racedExisting.error && !isNoRowsError(racedExisting.error)) {
      return res.status(500).json({
        ok: false,
        error: 'cart_lookup_failed',
        detail: racedExisting.error.message,
      });
    }
  }

  if (created.error) {
    return res.status(500).json({
      ok: false,
      error: 'cart_create_failed',
      detail: created.error.message,
    });
  }

  await emitCartEvent({
    cart_id: created.data.id,
    user_id: id.user_id,
    event_type: 'cart.created',
    event_payload: {},
  });

  return res.status(201).json({ ok: true, cart: created.data, created: true });
});

/**
 * GET / — Read the caller's active cart + active items.
 * Returns 200 with `cart: null, items: []` if no active cart exists (no autocreate).
 */
router.get('/', async (req: Request, res: Response) => {
  const id = await authorizeCommunityCaller(req, res);
  if (!id) return;

  const supabase = createUserSupabaseClient(id.token);

  const cartRes = await supabase
    .from('universal_carts')
    .select('*')
    .eq('user_id', id.user_id)
    .eq('status', 'active')
    .maybeSingle();

  if (cartRes.error && !isNoRowsError(cartRes.error)) {
    return res.status(500).json({
      ok: false,
      error: 'cart_lookup_failed',
      detail: cartRes.error.message,
    });
  }

  if (!cartRes.data) {
    return res.status(200).json({ ok: true, cart: null, items: [] });
  }

  const itemsRes = await supabase
    .from('universal_cart_items')
    .select('*')
    .eq('cart_id', cartRes.data.id)
    .eq('status', 'active')
    .order('created_at', { ascending: true });

  if (itemsRes.error) {
    return res.status(500).json({
      ok: false,
      error: 'cart_items_lookup_failed',
      detail: itemsRes.error.message,
    });
  }

  return res.status(200).json({ ok: true, cart: cartRes.data, items: itemsRes.data ?? [] });
});

/**
 * POST /items — Add an item to the caller's active cart.
 * If the product is already in the cart with status='active', bump its quantity
 * instead of creating a duplicate row.
 *
 * Emits `item.added` on either insert OR quantity bump (both are "added" events
 * from the user's perspective; analytics can disambiguate via quantity_before).
 */
router.post('/items', async (req: Request, res: Response) => {
  const id = await authorizeCommunityCaller(req, res);
  if (!id) return;

  const parsed = AddItemBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_request',
      detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  const body = parsed.data;

  const supabase = createUserSupabaseClient(id.token);

  // 0. VTID-03237 — Video Shop integrity check.
  // Adds attributed to the video feed must point at a product that is actually
  // purchasable (active + in stock) and, when a source_video_id is supplied,
  // genuinely anchored to that live video. This guards the new surface only;
  // existing web/mobile/voice/autopilot/community adds are unchanged.
  if (body.source_surface === 'video_shop') {
    const svc = getSupabase();
    if (!svc) {
      return res.status(500).json({ ok: false, error: 'service_unavailable' });
    }
    const product = await svc
      .from('products')
      .select('id, is_active, availability')
      .eq('id', body.product_id)
      .maybeSingle();
    if (product.error) {
      return res.status(500).json({ ok: false, error: 'product_lookup_failed', detail: product.error.message });
    }
    if (!product.data || product.data.is_active !== true) {
      return res.status(409).json({ ok: false, error: 'product_unavailable' });
    }
    if (product.data.availability !== 'in_stock') {
      return res.status(409).json({ ok: false, error: 'product_out_of_stock' });
    }
    if (body.source_video_id) {
      const anchor = await svc
        .from('shop_video_anchors')
        .select('id, shop_videos!inner(id, status, moderation_status)')
        .eq('video_id', body.source_video_id)
        .eq('product_id', body.product_id)
        .eq('shop_videos.status', 'active')
        .eq('shop_videos.moderation_status', 'approved')
        .maybeSingle();
      if (anchor.error) {
        return res.status(500).json({ ok: false, error: 'anchor_lookup_failed', detail: anchor.error.message });
      }
      if (!anchor.data) {
        return res.status(409).json({ ok: false, error: 'product_not_anchored_to_video' });
      }
    }
  }

  // 1. Resolve or create the active cart.
  const cartLookup = await supabase
    .from('universal_carts')
    .select('id')
    .eq('user_id', id.user_id)
    .eq('status', 'active')
    .maybeSingle();

  if (cartLookup.error && !isNoRowsError(cartLookup.error)) {
    return res.status(500).json({
      ok: false,
      error: 'cart_lookup_failed',
      detail: cartLookup.error.message,
    });
  }

  let cartId = cartLookup.data?.id as string | undefined;
  let cartCreatedThisRequest = false;

  if (!cartId) {
    const newCart = await supabase
      .from('universal_carts')
      .insert({
        user_id: id.user_id,
        tenant_id: id.tenant_id,
        status: 'active',
        metadata: {},
      })
      .select('id')
      .single();
    if (newCart.error && isUniqueViolation(newCart.error)) {
      const racedCart = await supabase
        .from('universal_carts')
        .select('id')
        .eq('user_id', id.user_id)
        .eq('status', 'active')
        .maybeSingle();

      if (racedCart.error && !isNoRowsError(racedCart.error)) {
        return res.status(500).json({
          ok: false,
          error: 'cart_lookup_failed',
          detail: racedCart.error.message,
        });
      }
      if (racedCart.data?.id) {
        cartId = racedCart.data.id as string;
      }
    } else if (newCart.error || !newCart.data) {
      return res.status(500).json({
        ok: false,
        error: 'cart_create_failed',
        detail: newCart.error?.message,
      });
    }
    if (!cartId && newCart.data?.id) {
      cartId = newCart.data.id as string;
      cartCreatedThisRequest = true;
      await emitCartEvent({
        cart_id: cartId,
        user_id: id.user_id,
        event_type: 'cart.created',
        event_payload: {},
      });
    }
    if (!cartId) {
      return res.status(500).json({
        ok: false,
        error: 'cart_create_failed',
        detail: newCart.error?.message,
      });
    }
  }

  // 2. Check whether the product is already in the cart with status='active'.
  const existingItem = await supabase
    .from('universal_cart_items')
    .select('*')
    .eq('cart_id', cartId!)
    .eq('product_id', body.product_id)
    .eq('status', 'active')
    .maybeSingle();

  if (existingItem.error && !isNoRowsError(existingItem.error)) {
    return res.status(500).json({
      ok: false,
      error: 'item_lookup_failed',
      detail: existingItem.error.message,
    });
  }

  const incomingMetadata: Record<string, unknown> = { ...(body.metadata || {}) };
  if (body.autopilot_rec_id) {
    // PRD Q3 — populate the day-1 autopilot linkage hint.
    incomingMetadata.autopilot_rec_id = body.autopilot_rec_id;
  }

  if (existingItem.data) {
    const before = Number(existingItem.data.quantity ?? 0);
    const after = before + body.quantity;
    const mergedMetadata = { ...(existingItem.data.metadata || {}), ...incomingMetadata };
    const updated = await supabase
      .from('universal_cart_items')
      .update({
        quantity: after,
        metadata: mergedMetadata,
      })
      .eq('id', existingItem.data.id)
      .select('*')
      .single();
    if (updated.error) {
      return res.status(500).json({
        ok: false,
        error: 'item_update_failed',
        detail: updated.error.message,
      });
    }
    await emitCartEvent({
      cart_id: cartId!,
      user_id: id.user_id,
      event_type: 'item.added',
      event_payload: {
        cart_item_id: updated.data.id,
        product_id: body.product_id,
        quantity_before: before,
        quantity_after: after,
        source_surface: body.source_surface,
        source_ref: body.source_ref,
      },
    });
    return res.status(200).json({
      ok: true,
      cart_id: cartId,
      item: updated.data,
      action: 'quantity_bumped',
      cart_created: cartCreatedThisRequest,
    });
  }

  // 3. INSERT a new cart_items row.
  const insertPayload: Record<string, unknown> = {
    cart_id: cartId,
    item_type: body.item_type,
    product_id: body.product_id,
    quantity: body.quantity,
    status: 'active',
    metadata: incomingMetadata,
  };
  if (body.merchant_id !== undefined) insertPayload.merchant_id = body.merchant_id;
  if (body.unit_price_cents_snapshot !== undefined) insertPayload.unit_price_cents_snapshot = body.unit_price_cents_snapshot;
  if (body.currency_snapshot !== undefined) insertPayload.currency_snapshot = body.currency_snapshot;
  if (body.source_surface !== undefined) insertPayload.source_surface = body.source_surface;
  if (body.source_ref !== undefined) insertPayload.source_ref = body.source_ref;
  if (body.source_video_id !== undefined) insertPayload.source_video_id = body.source_video_id;
  if (body.source_creator_id !== undefined) insertPayload.source_creator_id = body.source_creator_id;

  const inserted = await supabase
    .from('universal_cart_items')
    .insert(insertPayload)
    .select('*')
    .single();

  if (inserted.error) {
    return res.status(500).json({
      ok: false,
      error: 'item_insert_failed',
      detail: inserted.error.message,
    });
  }

  await emitCartEvent({
    cart_id: cartId!,
    user_id: id.user_id,
    event_type: 'item.added',
    event_payload: {
      cart_item_id: inserted.data.id,
      product_id: body.product_id,
      quantity_before: 0,
      quantity_after: body.quantity,
      source_surface: body.source_surface,
      source_ref: body.source_ref,
    },
  });

  return res.status(201).json({
    ok: true,
    cart_id: cartId,
    item: inserted.data,
    action: 'created',
    cart_created: cartCreatedThisRequest,
  });
});

/**
 * PATCH /items/:itemId — Update quantity / metadata for an active item.
 * RLS rejects updates to other users' items via parent-cart ownership; the
 * gateway never needs to check user_id explicitly on the items table.
 */
router.patch('/items/:itemId', async (req: Request, res: Response) => {
  const id = await authorizeCommunityCaller(req, res);
  if (!id) return;

  const parsed = PatchItemBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_request',
      detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  const body = parsed.data;
  const itemId = req.params.itemId;

  const supabase = createUserSupabaseClient(id.token);

  // Read the current row to capture quantity_before for the event payload.
  // RLS scopes this to the caller; cross-user reads return null.
  const current = await supabase
    .from('universal_cart_items')
    .select('id, cart_id, quantity, metadata, status')
    .eq('id', itemId)
    .maybeSingle();

  if (current.error && !isNoRowsError(current.error)) {
    return res.status(500).json({
      ok: false,
      error: 'item_lookup_failed',
      detail: current.error.message,
    });
  }
  if (!current.data) {
    return res.status(404).json({ ok: false, error: 'item_not_found' });
  }
  if (current.data.status !== 'active') {
    return res.status(409).json({
      ok: false,
      error: 'item_not_active',
      current_status: current.data.status,
    });
  }

  const updatePayload: Record<string, unknown> = {};
  if (body.quantity !== undefined) updatePayload.quantity = body.quantity;
  if (body.metadata !== undefined) {
    updatePayload.metadata = { ...(current.data.metadata || {}), ...body.metadata };
  }

  const updated = await supabase
    .from('universal_cart_items')
    .update(updatePayload)
    .eq('id', itemId)
    .select('*')
    .single();

  if (updated.error) {
    return res.status(500).json({
      ok: false,
      error: 'item_update_failed',
      detail: updated.error.message,
    });
  }

  if (body.quantity !== undefined && body.quantity !== Number(current.data.quantity)) {
    await emitCartEvent({
      cart_id: current.data.cart_id,
      user_id: id.user_id,
      event_type: 'item.quantity_changed',
      event_payload: {
        cart_item_id: itemId,
        quantity_before: Number(current.data.quantity),
        quantity_after: body.quantity,
      },
    });
  }

  return res.status(200).json({ ok: true, item: updated.data });
});

/**
 * DELETE /items/:itemId — Soft-remove (status='removed').
 * Hard delete is intentionally not exposed; audit trail relies on the row + event log.
 */
router.delete('/items/:itemId', async (req: Request, res: Response) => {
  const id = await authorizeCommunityCaller(req, res);
  if (!id) return;

  const itemId = req.params.itemId;
  const removalReason = typeof req.body?.removal_reason === 'string'
    ? String(req.body.removal_reason).slice(0, 200)
    : undefined;

  const supabase = createUserSupabaseClient(id.token);

  const current = await supabase
    .from('universal_cart_items')
    .select('id, cart_id, status')
    .eq('id', itemId)
    .maybeSingle();

  if (current.error && !isNoRowsError(current.error)) {
    return res.status(500).json({
      ok: false,
      error: 'item_lookup_failed',
      detail: current.error.message,
    });
  }
  if (!current.data) {
    return res.status(404).json({ ok: false, error: 'item_not_found' });
  }
  if (current.data.status !== 'active') {
    return res.status(409).json({
      ok: false,
      error: 'item_not_active',
      current_status: current.data.status,
    });
  }

  const updated = await supabase
    .from('universal_cart_items')
    .update({ status: 'removed' })
    .eq('id', itemId)
    .select('*')
    .single();

  if (updated.error) {
    return res.status(500).json({
      ok: false,
      error: 'item_remove_failed',
      detail: updated.error.message,
    });
  }

  await emitCartEvent({
    cart_id: current.data.cart_id,
    user_id: id.user_id,
    event_type: 'item.removed',
    event_payload: {
      cart_item_id: itemId,
      removal_reason: removalReason,
    },
  });

  return res.status(200).json({ ok: true, item: updated.data });
});

/**
 * POST /items/:itemId/complete — Mark item completed (PRD Q4: explicit callback).
 * Called by the existing per-item flow (single-item product_orders) on success.
 */
router.post('/items/:itemId/complete', async (req: Request, res: Response) => {
  const id = await authorizeCommunityCaller(req, res);
  if (!id) return;

  const itemId = req.params.itemId;

  const supabase = createUserSupabaseClient(id.token);

  const current = await supabase
    .from('universal_cart_items')
    .select('id, cart_id, status, product_id')
    .eq('id', itemId)
    .maybeSingle();

  if (current.error && !isNoRowsError(current.error)) {
    return res.status(500).json({
      ok: false,
      error: 'item_lookup_failed',
      detail: current.error.message,
    });
  }
  if (!current.data) {
    return res.status(404).json({ ok: false, error: 'item_not_found' });
  }
  if (current.data.status === 'completed') {
    // Idempotent: caller may retry the callback safely.
    return res.status(200).json({
      ok: true,
      item: current.data,
      already_completed: true,
    });
  }
  if (current.data.status !== 'active') {
    return res.status(409).json({
      ok: false,
      error: 'item_not_active',
      current_status: current.data.status,
    });
  }

  const updated = await supabase
    .from('universal_cart_items')
    .update({ status: 'completed' })
    .eq('id', itemId)
    .select('*')
    .single();

  if (updated.error) {
    return res.status(500).json({
      ok: false,
      error: 'item_complete_failed',
      detail: updated.error.message,
    });
  }

  await emitCartEvent({
    cart_id: current.data.cart_id,
    user_id: id.user_id,
    event_type: 'item.completed',
    event_payload: {
      cart_item_id: itemId,
      product_id: current.data.product_id,
    },
  });

  return res.status(200).json({ ok: true, item: updated.data });
});

/**
 * GET /events — Read recent events for the caller's active cart.
 * RLS gates SELECT via parent-cart ownership (universal_cart_events_select_via_cart),
 * so the user-JWT-scoped client will only return events the caller owns.
 */
router.get('/events', async (req: Request, res: Response) => {
  const id = await authorizeCommunityCaller(req, res);
  if (!id) return;

  const supabase = createUserSupabaseClient(id.token);

  // Find the caller's active cart first so we can scope the events query to it.
  const cartRes = await supabase
    .from('universal_carts')
    .select('id')
    .eq('user_id', id.user_id)
    .eq('status', 'active')
    .maybeSingle();

  if (cartRes.error && !isNoRowsError(cartRes.error)) {
    return res.status(500).json({
      ok: false,
      error: 'cart_lookup_failed',
      detail: cartRes.error.message,
    });
  }
  if (!cartRes.data) {
    return res.status(200).json({ ok: true, events: [] });
  }

  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;

  const eventsRes = await supabase
    .from('universal_cart_events')
    .select('*')
    .eq('cart_id', cartRes.data.id)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (eventsRes.error) {
    return res.status(500).json({
      ok: false,
      error: 'events_lookup_failed',
      detail: eventsRes.error.message,
    });
  }

  return res.status(200).json({ ok: true, events: eventsRes.data ?? [] });
});

export default router;
