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
 * Prices are never taken from the client. The Stripe webhook branch lives in
 * routes/billing.ts (vitana_kind 'reward_shipping').
 */
import { Router, Response } from 'express';
import { getSupabase } from '../lib/supabase';
import { requireAuth, requireExafyAdmin, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import * as repo from '../services/rewards/reward-shop-repository';
import { getShop, redeem, setOrderStatus, isShopCurrency } from '../services/rewards/reward-shop';

const router = Router();
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://community-app.vitanaland.com';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ADDRESS_FIELDS = ['name', 'line1', 'line2', 'postal_code', 'city', 'region'] as const;
const ADMIN_STATUSES = new Set(['fulfilling', 'shipped', 'delivered']);

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

export default router;
