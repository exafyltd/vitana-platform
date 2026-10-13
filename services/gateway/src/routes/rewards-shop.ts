/**
 * VTID-04982 — Rewards shop routes.
 *
 *   GET  /api/v1/rewards/shop                    member: items, prices, earned balance, shipping fees
 *   POST /api/v1/rewards/shop/redeem             member: redeem one item with earned VTNA
 *   GET  /api/v1/rewards/orders                  member: own orders
 *   GET  /api/v1/admin/rewards/orders            exafy_admin: orders (optional ?status=)
 *   PATCH /api/v1/admin/rewards/orders/:id       exafy_admin: fulfilment status
 *   GET  /api/v1/admin/rewards/items             exafy_admin: whole catalogue
 *   PUT  /api/v1/admin/rewards/items             exafy_admin: create/update one item (by slug)
 *   PUT  /api/v1/admin/rewards/shipping-fees     exafy_admin: one fee row
 *
 * VTID-05035 — admin screen support:
 *   POST   /api/v1/admin/rewards/items/image                       exafy_admin: one item photo -> public URL
 *   GET    /api/v1/admin/rewards/shipping-fees                     exafy_admin: every fee row
 *   DELETE /api/v1/admin/rewards/shipping-fees/:country/:currency  exafy_admin: remove one fee row
 *
 * Prices are never taken from the client. The Stripe webhook branch lives in
 * routes/billing.ts (vitana_kind 'reward_shipping').
 */
import { randomUUID } from 'crypto';
import { Router, Response } from 'express';
import { getSupabase } from '../lib/supabase';
import { requireAuth, requireExafyAdmin, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import * as repo from '../services/rewards/reward-shop-repository';
import { getShop, redeem, setOrderStatus, isShopCurrency } from '../services/rewards/reward-shop';
import { storageUpload, storagePublicUrl } from '../services/storage/storage-provider';

const router = Router();
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://community-app.vitanaland.com';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ADDRESS_FIELDS = ['name', 'line1', 'line2', 'postal_code', 'city', 'region'] as const;
const ADMIN_STATUSES = new Set(['fulfilling', 'shipped', 'delivered']);

// VTID-05035 — item photos. The app shrinks a photo before sending it, so the
// decoded image is capped at 1.4 MB: its base64 JSON body then stays under the
// gateway's 2 MB express.json limit. The bucket enforces the same cap and types.
export const REWARD_SHOP_IMAGE_BUCKET = 'reward-shop-images';
export const MAX_ITEM_IMAGE_BYTES = 1_468_006;
const IMAGE_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
// Buffer.from(str, 'base64') never throws on malformed input (see storage-bridge.ts),
// so the charset is checked before decoding.
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** The image type the bytes really are, by magic number; null for anything else. */
export function detectImageType(bytes: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function cleanAddress(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: Record<string, string> = {};
  for (const k of ADDRESS_FIELDS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 200);
  }
  return Object.keys(out).length ? out : null;
}

router.get('/rewards/shop', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.identity?.user_id;
  if (!userId) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED' });
  const shop = await getShop(sb, userId);
  return res.status(shop.ok ? 200 : 500).json(shop);
});

router.post('/rewards/shop/redeem', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  // impact-allow-no-oasis: reward-shop.ts emits rewards.shop.redeemed / shipping_paid / refunded.
  const identity = req.identity;
  if (!identity?.user_id || !identity?.tenant_id) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const itemId = typeof body.item_id === 'string' ? body.item_id : '';
  const idem = typeof body.idempotency_key === 'string' ? body.idempotency_key.trim() : '';
  if (!UUID.test(itemId) || idem.length < 8 || idem.length > 200) {
    return res.status(400).json({ ok: false, error: 'ARGS_REQUIRED' });
  }
  const currency = isShopCurrency(body.currency) ? body.currency : 'EUR';
  const birthDate = typeof body.birth_date === 'string' && DATE.test(body.birth_date) ? body.birth_date : null;
  const country = typeof body.country === 'string' ? body.country.trim().toUpperCase().slice(0, 2) : null;

  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED' });
  const result = await redeem(sb, {
    userId: identity.user_id,
    tenantId: identity.tenant_id,
    email: identity.email ?? null,
    itemId,
    idempotencyKey: idem,
    currency,
    country,
    address: cleanAddress(body.address),
    birthDate,
    ageConfirmed: body.age_confirmed === true,
    locale: typeof body.locale === 'string' ? body.locale : null,
    frontendUrl: FRONTEND_URL,
  });
  if (!result.ok) {
    return res.status(result.status_code).json({ ok: false, error: result.error, ...(result.detail ?? {}) });
  }
  return res.json(result);
});

router.get('/rewards/orders', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.identity?.user_id;
  if (!userId) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED' });
  const { data, error } = await repo.fetchMemberOrders(sb, userId);
  if (error) return res.status(500).json({ ok: false, error: 'ORDERS_READ_FAILED' });
  return res.json({ ok: true, orders: data ?? [] });
});

router.get('/admin/rewards/orders', requireAuth, requireExafyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED' });
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const { data, error } = await repo.fetchOrdersForAdmin(sb, status);
  if (error) return res.status(500).json({ ok: false, error: 'ORDERS_READ_FAILED' });
  return res.json({ ok: true, orders: data ?? [] });
});

router.patch('/admin/rewards/orders/:id', requireAuth, requireExafyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  // impact-allow-no-oasis: setOrderStatus() emits rewards.shop.order_status_changed.
  const id = req.params.id;
  const status = typeof req.body?.status === 'string' ? req.body.status : '';
  if (!UUID.test(id) || !ADMIN_STATUSES.has(status)) return res.status(400).json({ ok: false, error: 'ARGS_REQUIRED' });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED' });
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null;
  const r = await setOrderStatus(sb, id, status, reason, req.identity!.user_id);
  if (!r.ok) return res.status(r.status_code).json({ ok: false, error: r.error });
  return res.json(r);
});

router.get('/admin/rewards/items', requireAuth, requireExafyAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED' });
  const { data, error } = await repo.fetchAllItems(sb);
  if (error) return res.status(500).json({ ok: false, error: 'ITEMS_READ_FAILED' });
  return res.json({ ok: true, items: data ?? [] });
});

router.put('/admin/rewards/items', requireAuth, requireExafyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  // impact-allow-no-oasis: catalogue data edit by an admin; the table keeps updated_at.
  const b = (req.body ?? {}) as Record<string, unknown>;
  const fulfilment = b.fulfilment;
  if (typeof b.slug !== 'string' || !b.titles || typeof b.titles !== 'object'
      || typeof b.vtna_price !== 'number' || !Number.isInteger(b.vtna_price) || b.vtna_price <= 0
      || (fulfilment !== 'ship' && fulfilment !== 'event' && fulfilment !== 'digital')) {
    return res.status(400).json({ ok: false, error: 'INVALID_ITEM' });
  }
  const item: Record<string, unknown> = {
    slug: b.slug,
    titles: b.titles,
    descriptions: b.descriptions && typeof b.descriptions === 'object' ? b.descriptions : {},
    images: Array.isArray(b.images) ? b.images.filter((x) => typeof x === 'string') : [],
    vtna_price: b.vtna_price,
    fulfilment,
    age_restricted: b.age_restricted === true,
    min_age: typeof b.min_age === 'number' ? b.min_age : null,
    ships_to_countries: Array.isArray(b.ships_to_countries)
      ? b.ships_to_countries.filter((c) => typeof c === 'string' && /^[A-Z]{2}$/.test(c)) : [],
    stock: typeof b.stock === 'number' ? b.stock : null,
    is_active: b.is_active === true,
    sort_order: typeof b.sort_order === 'number' ? b.sort_order : 100,
    updated_at: new Date().toISOString(),
  };
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED' });
  const { data, error } = await repo.upsertItem(sb, item);
  if (error) return res.status(400).json({ ok: false, error: 'ITEM_REJECTED', message: error.message });
  return res.json({ ok: true, item: data });
});

router.put('/admin/rewards/shipping-fees', requireAuth, requireExafyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  // impact-allow-no-oasis: shipping fee configuration by an admin; the table keeps updated_at.
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (typeof b.country !== 'string' || !/^[A-Z]{2}$/.test(b.country) || !isShopCurrency(b.currency)
      || typeof b.fee_cents !== 'number' || !Number.isInteger(b.fee_cents) || b.fee_cents < 0) {
    return res.status(400).json({ ok: false, error: 'INVALID_FEE' });
  }
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED' });
  const { error } = await repo.upsertShippingFee(sb, { country: b.country, currency: b.currency, fee_cents: b.fee_cents });
  if (error) return res.status(400).json({ ok: false, error: 'FEE_REJECTED', message: error.message });
  return res.json({ ok: true });
});

router.post('/admin/rewards/items/image', requireAuth, requireExafyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  // impact-allow-no-oasis: stores one catalogue photo and returns its URL; no item changes until the admin saves it via PUT /admin/rewards/items.
  const b = (req.body ?? {}) as Record<string, unknown>;
  const declared = typeof b.content_type === 'string' ? b.content_type.trim().toLowerCase() : '';
  const raw = typeof b.data_base64 === 'string' ? b.data_base64.replace(/\s/g, '') : '';
  if (!declared || !raw) return res.status(400).json({ ok: false, error: 'ARGS_REQUIRED' });
  // Reject an oversize body before decoding it (4 base64 chars carry 3 bytes).
  if (Math.floor((raw.length * 3) / 4) - 2 > MAX_ITEM_IMAGE_BYTES) {
    return res.status(413).json({ ok: false, error: 'IMAGE_TOO_LARGE', max_bytes: MAX_ITEM_IMAGE_BYTES });
  }
  if (!IMAGE_EXT[declared] || !BASE64_RE.test(raw)) {
    return res.status(400).json({ ok: false, error: 'IMAGE_TYPE_NOT_ALLOWED' });
  }
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length === 0) return res.status(400).json({ ok: false, error: 'ARGS_REQUIRED' });
  if (bytes.length > MAX_ITEM_IMAGE_BYTES) {
    return res.status(413).json({ ok: false, error: 'IMAGE_TOO_LARGE', max_bytes: MAX_ITEM_IMAGE_BYTES });
  }
  const detected = detectImageType(bytes);
  if (!detected || detected !== declared) {
    return res.status(400).json({ ok: false, error: 'IMAGE_TYPE_NOT_ALLOWED' });
  }
  const path = `items/${randomUUID()}.${IMAGE_EXT[detected]}`;
  try {
    const { error } = await storageUpload(REWARD_SHOP_IMAGE_BUCKET, path, bytes, {
      contentType: detected,
      upsert: false,
      cacheControl: '31536000', // the path is a fresh uuid per upload, never overwritten
    });
    if (error) {
      console.error(`[rewards-shop] item image upload failed: ${error.message}`);
      return res.status(500).json({ ok: false, error: 'IMAGE_UPLOAD_FAILED' });
    }
    const url = storagePublicUrl(REWARD_SHOP_IMAGE_BUCKET, path);
    return res.json({ ok: true, url, path });
  } catch (err) {
    console.error(`[rewards-shop] item image upload failed: ${err instanceof Error ? err.message : String(err)}`);
    return res.status(500).json({ ok: false, error: 'IMAGE_UPLOAD_FAILED' });
  }
});

router.get('/admin/rewards/shipping-fees', requireAuth, requireExafyAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED' });
  const { data, error } = await repo.fetchAllShippingFees(sb);
  if (error) return res.status(500).json({ ok: false, error: 'FEES_READ_FAILED' });
  return res.json({ ok: true, fees: data ?? [] });
});

router.delete('/admin/rewards/shipping-fees/:country/:currency', requireAuth, requireExafyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  // impact-allow-no-oasis: shipping fee configuration by an admin, same category as PUT /admin/rewards/shipping-fees.
  const { country, currency } = req.params;
  if (!/^[A-Z]{2}$/.test(country) || !isShopCurrency(currency)) {
    return res.status(400).json({ ok: false, error: 'ARGS_REQUIRED' });
  }
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED' });
  const { error } = await repo.deleteShippingFee(sb, country, currency);
  if (error) return res.status(400).json({ ok: false, error: 'FEE_REJECTED', message: error.message });
  return res.json({ ok: true });
});

export default router;
