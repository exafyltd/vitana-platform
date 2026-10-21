/**
 * VTID-04982 — Rewards shop: gateway behaviour.
 *  - routes: auth, admin gate, input validation, prices never from the client;
 *  - redeem: event items paid in VTNA; ship items open a Stripe Checkout for
 *    the shipping fee only, a replay reuses that session, a failed checkout
 *    releases the hold;
 *  - billing webhook: completed -> settle, refund when the SQL says so,
 *    expired -> release; other kinds untouched;
 *  - the reservation sweep: production ECS only, OASIS event per release;
 *  - the SQL harness (scripts/ci/test-vtid-04982-…) when PostgreSQL exists.
 */
import express from 'express';
import request from 'supertest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE = 'service-role';

jest.mock('../src/middleware/auth-supabase-jwt', () => {
  const identify = (req: any) => {
    const h = String(req.headers.authorization || '');
    if (h === 'Bearer admin') return { user_id: 'admin-1', exafy_admin: true, tenant_id: 't1', email: null };
    if (h === 'Bearer member') return { user_id: '11111111-1111-1111-1111-111111111111', exafy_admin: false, tenant_id: 't1', email: 'm@example.com' };
    return null;
  };
  return {
    requireAuth: (req: any, res: any, next: any) => {
      const id = identify(req);
      if (!id) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
      req.identity = id;
      return next();
    },
    requireExafyAdmin: (req: any, res: any, next: any) =>
      req.identity?.exafy_admin ? next() : res.status(403).json({ ok: false, error: 'FORBIDDEN' }),
  };
});
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../src/lib/supabase', () => ({ getSupabase: jest.fn(() => ({})) }));
jest.mock('../src/services/rewards/reward-shop-repository', () => ({
  fetchActiveItems: jest.fn(),
  fetchAllItems: jest.fn(),
  fetchShippingFees: jest.fn(),
  fetchEarnedBalance: jest.fn(),
  fetchMemberOrders: jest.fn(),
  fetchOrder: jest.fn(),
  fetchOrdersForAdmin: jest.fn(),
  attachStripeSession: jest.fn().mockResolvedValue({ error: null }),
  upsertItem: jest.fn(),
  upsertShippingFee: jest.fn(),
  rpcRedeem: jest.fn(),
  rpcSettleShipping: jest.fn(),
  rpcReleaseReservation: jest.fn(),
  rpcReleaseExpired: jest.fn(),
  rpcSetStatus: jest.fn(),
}));

import * as repo from '../src/services/rewards/reward-shop-repository';
import { emitOasisEvent } from '../src/services/oasis-event-service';
import {
  __setStripeForTests, settleShipping, releaseOnExpiry, releaseExpiredReservations,
  reservationSweepAllowed,
} from '../src/services/rewards/reward-shop';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const shopRouter = require('../src/routes/rewards-shop').default;
const app = express();
app.use(express.json());
app.use('/api/v1', shopRouter);

const r = repo as unknown as Record<string, jest.Mock>;
const ITEM = '22222222-2222-2222-2222-222222222222';
const WINE = {
  id: ITEM, slug: 'son-amaret-chardonnay', titles: { de: 'Son Amaret Chardonnay DE', en: 'Son Amaret Chardonnay' },
  descriptions: {}, images: [], vtna_price: 1200, fulfilment: 'ship', age_restricted: true, min_age: 18,
  ships_to_countries: ['DE'], stock: 10, reserved: 0, is_active: true, sort_order: 1,
};
const stripe = {
  checkout: { sessions: { create: jest.fn(), retrieve: jest.fn() } },
  refunds: { create: jest.fn() },
};

beforeEach(() => {
  jest.clearAllMocks();
  __setStripeForTests(stripe as any);
  r.fetchActiveItems.mockResolvedValue({ data: [WINE], error: null });
  r.fetchShippingFees.mockResolvedValue({ data: [{ country: 'DE', currency: 'EUR', fee_cents: 690 }], error: null });
  r.fetchEarnedBalance.mockResolvedValue({ data: { earned_balance: 2000 }, error: null });
  stripe.checkout.sessions.create.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' });
});

describe('GET /api/v1/rewards/shop', () => {
  it('needs a member; lists items with VTNA, EUR value, availability and affordability', async () => {
    expect((await request(app).get('/api/v1/rewards/shop')).status).toBe(401);
    const res = await request(app).get('/api/v1/rewards/shop').set('Authorization', 'Bearer member');
    expect(res.status).toBe(200);
    expect(res.body.earned_balance).toBe(2000);
    expect(res.body.items[0]).toMatchObject({ id: ITEM, vtna_price: 1200, eur_value: 12, available: true, affordable: true, age_restricted: true });
    expect(res.body.shipping_fees).toEqual([{ country: 'DE', currency: 'EUR', fee_cents: 690 }]);
  });
});

describe('POST /api/v1/rewards/shop/redeem', () => {
  const body = { item_id: ITEM, idempotency_key: 'idem-12345678', currency: 'EUR', country: 'de',
    address: { name: 'A', line1: 'Street 1', postal_code: '10115', city: 'Berlin', evil: 'x' },
    birth_date: '1980-01-01', age_confirmed: true, locale: 'en', vtna_price: 1 };

  it('rejects bad input before touching the database', async () => {
    const res = await request(app).post('/api/v1/rewards/shop/redeem').set('Authorization', 'Bearer member').send({ item_id: 'x' });
    expect(res.status).toBe(400);
    expect(r.rpcRedeem).not.toHaveBeenCalled();
  });

  it('ship item: reserves, opens a Stripe Checkout for the shipping fee only, never takes a price from the client', async () => {
    r.rpcRedeem.mockResolvedValue({ data: { ok: true, order_id: 'o-1', status: 'awaiting_shipping_payment', vtna_amount: 1200,
      shipping_fee_cents: 690, shipping_currency: 'EUR' }, error: null });
    const res = await request(app).post('/api/v1/rewards/shop/redeem').set('Authorization', 'Bearer member').send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, order_id: 'o-1', status: 'awaiting_shipping_payment', checkout_url: 'https://checkout.stripe.test/cs_1' });
    const params = r.rpcRedeem.mock.calls[0][1];
    expect(params).toMatchObject({ p_item_id: ITEM, p_country: 'DE', p_birth_date: '1980-01-01', p_age_confirmed: true, p_currency: 'EUR' });
    expect(params.p_address).toEqual({ name: 'A', line1: 'Street 1', postal_code: '10115', city: 'Berlin' });
    expect(JSON.stringify(params)).not.toContain('vtna_price');
    const session = stripe.checkout.sessions.create.mock.calls[0][0];
    expect(session.line_items).toEqual([{ quantity: 1, price_data: { currency: 'eur', unit_amount: 690, product_data: { name: 'Son Amaret Chardonnay' } } }]);
    expect(session.metadata).toMatchObject({ vitana_kind: 'reward_shipping', vitana_order_id: 'o-1' });
    expect(session.expires_at - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(30 * 60);
    expect(r.attachStripeSession).toHaveBeenCalledWith(expect.anything(), 'o-1', 'cs_1');
  });

  it('a replay hands back the session already opened for the order', async () => {
    r.rpcRedeem.mockResolvedValue({ data: { ok: true, duplicate: true, order_id: 'o-1', status: 'awaiting_shipping_payment', vtna_amount: 1200 }, error: null });
    r.fetchOrder.mockResolvedValue({ data: { stripe_session_id: 'cs_1' }, error: null });
    stripe.checkout.sessions.retrieve.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' });
    const res = await request(app).post('/api/v1/rewards/shop/redeem').set('Authorization', 'Bearer member').send(body);
    expect(res.body).toMatchObject({ ok: true, duplicate: true, checkout_url: 'https://checkout.stripe.test/cs_1' });
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('a failed checkout releases the hold', async () => {
    r.rpcRedeem.mockResolvedValue({ data: { ok: true, order_id: 'o-2', status: 'awaiting_shipping_payment', vtna_amount: 1200,
      shipping_fee_cents: 690, shipping_currency: 'EUR' }, error: null });
    stripe.checkout.sessions.create.mockRejectedValue(new Error('stripe down'));
    const res = await request(app).post('/api/v1/rewards/shop/redeem').set('Authorization', 'Bearer member').send(body);
    expect(res.status).toBe(502);
    expect(r.rpcReleaseReservation).toHaveBeenCalledWith(expect.anything(), 'o-2', 'checkout_failed');
  });

  it('event item: paid in VTNA at once, OASIS rewards.shop.redeemed, no Stripe', async () => {
    r.rpcRedeem.mockResolvedValue({ data: { ok: true, order_id: 'o-3', status: 'paid', vtna_amount: 300 }, error: null });
    const res = await request(app).post('/api/v1/rewards/shop/redeem').set('Authorization', 'Bearer member').send(body);
    expect(res.body).toMatchObject({ ok: true, status: 'paid', vtna_amount: 300 });
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect((emitOasisEvent as jest.Mock).mock.calls.map(([e]) => e.type)).toContain('rewards.shop.redeemed');
  });

  it.each([
    ['INSUFFICIENT_BALANCE', 409], ['OUT_OF_STOCK', 409], ['UNDER_MIN_AGE', 403], ['AGE_CONFIRMATION_REQUIRED', 400],
    ['NOT_ELIGIBLE', 403], ['ITEM_NOT_AVAILABLE', 404], ['SHIPPING_NOT_AVAILABLE', 409],
  ])('maps %s to %i', async (code, status) => {
    r.rpcRedeem.mockResolvedValue({ data: { ok: false, error: code }, error: null });
    const res = await request(app).post('/api/v1/rewards/shop/redeem').set('Authorization', 'Bearer member').send(body);
    expect(res.status).toBe(status);
    expect(res.body.error).toBe(code);
  });
});

describe('admin routes', () => {
  it('are exafy_admin only', async () => {
    for (const [m, u] of [['get', '/api/v1/admin/rewards/orders'], ['get', '/api/v1/admin/rewards/items']] as const) {
      expect((await (request(app) as any)[m](u).set('Authorization', 'Bearer member')).status).toBe(403);
    }
  });

  it('PATCH status accepts only fulfilment statuses and reports the transition', async () => {
    const id = '33333333-3333-3333-3333-333333333333';
    expect((await request(app).patch(`/api/v1/admin/rewards/orders/${id}`).set('Authorization', 'Bearer admin').send({ status: 'paid' })).status).toBe(400);
    r.rpcSetStatus.mockResolvedValue({ data: { ok: true, from: 'paid', to: 'shipped' }, error: null });
    const res = await request(app).patch(`/api/v1/admin/rewards/orders/${id}`).set('Authorization', 'Bearer admin').send({ status: 'shipped' });
    expect(res.body).toMatchObject({ ok: true, from: 'paid', to: 'shipped' });
    expect((emitOasisEvent as jest.Mock).mock.calls.map(([e]) => e.type)).toContain('rewards.shop.order_status_changed');
  });

  it('PUT item validates the price and fulfilment', async () => {
    const res = await request(app).put('/api/v1/admin/rewards/items').set('Authorization', 'Bearer admin')
      .send({ slug: 'x', titles: { de: 'X' }, vtna_price: -5, fulfilment: 'ship' });
    expect(res.status).toBe(400);
    expect(r.upsertItem).not.toHaveBeenCalled();
  });
});

describe('billing webhook handlers', () => {
  const session = (extra: Record<string, unknown> = {}) => ({
    id: 'cs_1', payment_intent: 'pi_1', metadata: { vitana_kind: 'reward_shipping', vitana_order_id: 'o-1' }, ...extra,
  }) as any;

  it('completed -> settle; paid emits shipping_paid, no refund', async () => {
    r.rpcSettleShipping.mockResolvedValue({ data: { ok: true, status: 'paid', refund: false }, error: null });
    await settleShipping({} as any, session());
    expect(r.rpcSettleShipping).toHaveBeenCalledWith(expect.anything(), { p_order_id: 'o-1', p_session_id: 'cs_1', p_payment_intent: 'pi_1' });
    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect((emitOasisEvent as jest.Mock).mock.calls.map(([e]) => e.type)).toContain('rewards.shop.shipping_paid');
  });

  it('refunds the Stripe charge when the VTNA or the stock is gone', async () => {
    r.rpcSettleShipping.mockResolvedValue({ data: { ok: false, error: 'INSUFFICIENT_BALANCE', refund: true }, error: null });
    await settleShipping({} as any, session());
    expect(stripe.refunds.create).toHaveBeenCalledWith({ payment_intent: 'pi_1' }, { idempotencyKey: 'reward_refund:o-1' });
    expect((emitOasisEvent as jest.Mock).mock.calls.map(([e]) => e.type)).toContain('rewards.shop.refunded');
  });

  it('a database error throws so Stripe retries the webhook', async () => {
    r.rpcSettleShipping.mockResolvedValue({ data: null, error: { message: 'db down' } });
    await expect(settleShipping({} as any, session())).rejects.toThrow('db down');
  });

  it('expired -> release the hold once', async () => {
    r.rpcReleaseReservation.mockResolvedValue({ data: { ok: true, released: true }, error: null });
    await releaseOnExpiry({} as any, session());
    expect(r.rpcReleaseReservation).toHaveBeenCalledWith(expect.anything(), 'o-1', 'stripe_expired');
    expect((emitOasisEvent as jest.Mock).mock.calls.map(([e]) => e.type)).toContain('rewards.shop.reservation_expired');
  });

  it('billing.ts routes reward_shipping to the shop and handles checkout.session.expired', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/billing.ts'), 'utf8');
    expect(src).toMatch(/if \(kind === 'reward_shipping'\) \{\s+await settleRewardShipping\(sb\(\), session\);\s+return;/);
    expect(src).toMatch(/case 'checkout\.session\.expired':[\s\S]{0,300}releaseRewardOnExpiry\(sb\(\), expired\)/);
  });
});

describe('reservation sweep', () => {
  it('runs only on production ECS', () => {
    expect(reservationSweepAllowed({ ECS_CONTAINER_METADATA_URI_V4: 'x' } as any)).toBe(true);
    expect(reservationSweepAllowed({ ECS_CONTAINER_METADATA_URI_V4: 'x', VITANA_ENV: 'staging' } as any)).toBe(false);
    expect(reservationSweepAllowed({} as any)).toBe(false);
  });

  it('reports releases to OASIS and stays quiet when none', async () => {
    r.rpcReleaseExpired.mockResolvedValue({ data: 2, error: null });
    expect(await releaseExpiredReservations({} as any)).toBe(2);
    expect((emitOasisEvent as jest.Mock)).toHaveBeenCalledTimes(1);
    (emitOasisEvent as jest.Mock).mockClear();
    r.rpcReleaseExpired.mockResolvedValue({ data: 0, error: null });
    expect(await releaseExpiredReservations({} as any)).toBe(0);
    expect(emitOasisEvent).not.toHaveBeenCalled();
  });
});

describe('VTID-04982 migration', () => {
  const REPO = path.join(__dirname, '../../..');
  const sql = fs.readFileSync(path.join(REPO, 'supabase/migrations/20261008180000_vtid_04982_rewards_shop.sql'), 'utf8');

  it('refuses to apply while fn_consume_credits is open to members, and keeps every function server-side', () => {
    expect(sql).toContain('apply VTID-04981 first');
    expect(sql).toContain('must not be executable by members');
    expect(sql.match(/FROM PUBLIC, anon, authenticated;/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it('debits only earned VTNA through credit_wallet, never stores a birth date, refuses test accounts', () => {
    expect(sql).toMatch(/credit_wallet\([^)]*-v_item\.vtna_price, 'reward', 'reward_shop'/);
    expect(sql).toMatch(/credit_wallet\([^)]*-v_order\.vtna_amount, 'reward', 'reward_shop'/);
    const ordersTable = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS public.reward_orders'), sql.indexOf('CREATE INDEX IF NOT EXISTS reward_orders_user_idx'));
    expect(ordersTable).toContain('age_confirmed_at');
    expect(ordersTable).not.toMatch(/birth/i);
    expect(sql).toContain('reward_sweep_is_excluded(p_user_id)');
  });

  const pgBin = (() => {
    try {
      const dirs = fs.readdirSync('/usr/lib/postgresql').sort();
      const bin = `/usr/lib/postgresql/${dirs[dirs.length - 1]}/bin`;
      return fs.existsSync(`${bin}/initdb`) ? bin : null;
    } catch {
      return null;
    }
  })();
  (pgBin ? it : it.skip)('applies twice and passes the SQL assertions', () => {
    const out = execFileSync(path.join(REPO, 'scripts/ci/test-vtid-04982-rewards-shop.sh'), {
      env: { ...process.env, PGBIN: pgBin!, PGPORT_TEST: '55443' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out).toContain('VTID-04982: all assertions passed');
  }, 120_000);
});
