/**
 * VTID-03237 (V1.2) — Universal Cart checkout bridge tests.
 *
 * Exercises the hybrid routing (first-party → wallet, affiliate → click-out),
 * the money-safety ordering (pending orders → debit → settle), and the failure
 * paths (insufficient balance, stale cart, mixed currency, etc.) with a fully
 * mocked Supabase client + wallet debit RPC.
 */

const mockDebit = jest.fn();
jest.mock('../src/services/wallet/spend-earning-service', () => ({
  debitWalletForSpend: (...args: unknown[]) => mockDebit(...args),
}));

const mockGetSupabase = jest.fn();
jest.mock('../src/lib/supabase', () => ({
  getSupabase: () => mockGetSupabase(),
}));

import { checkoutUniversalCart } from '../src/services/checkout/checkout-service';

const KEY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; // deterministic checkout_id
const USER = 'u-1';
const TENANT = 't-1';

/**
 * Build a chainable Supabase mock. `plan` is keyed by `${table}.${op}` where op
 * is select | insert | update. Each entry is the `{ data, error }` the call
 * resolves to (terminal `.maybeSingle()`/`.single()` and awaited chains alike).
 */
function makeSupabase(plan: Record<string, { data?: any; error?: any }>) {
  const calls: { table: string; op: string }[] = [];
  const resolve = (table: string, op: string) => {
    calls.push({ table, op });
    const hit = plan[`${table}.${op}`];
    return { data: hit?.data ?? null, error: hit?.error ?? null };
  };
  const from = (table: string) => {
    let op = 'select';
    const builder: any = {
      select: () => builder,
      insert: (_rows: any) => { op = 'insert'; return builder; },
      update: (_vals: any) => { op = 'update'; return builder; },
      eq: () => builder,
      in: () => builder,
      like: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: () => Promise.resolve(resolve(table, op)),
      single: () => Promise.resolve(resolve(table, op)),
      then: (onF: any, onR: any) => Promise.resolve(resolve(table, op)).then(onF, onR),
    };
    return builder;
  };
  return { client: { from }, calls };
}

const ACTIVE_CART = { 'universal_carts.select': { data: { id: 'cart-1', user_id: USER, status: 'active' } } };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('checkoutUniversalCart — hybrid bridge', () => {
  it('first-party only: debits wallet, converts orders, completes items', async () => {
    mockDebit.mockResolvedValueOnce({ ok: true, duplicate: false, balance_minor: 3000, currency: 'EUR' });
    const { client } = makeSupabase({
      ...ACTIVE_CART,
      'universal_cart_items.select': {
        data: [{
          id: 'it1', product_id: 'p1', quantity: 2, unit_price_cents_snapshot: 1000,
          currency_snapshot: 'EUR', source_surface: 'video_shop', source_video_id: 'v1',
          source_creator_id: 'c1', item_type: 'partner_product',
        }],
      },
      'products.select': {
        data: [{ id: 'p1', source_network: 'manual', price_cents: 1000, currency: 'EUR', is_active: true, availability: 'in_stock', merchant_id: 'm1', affiliate_url: null }],
      },
      'wallet_accounts.select': { data: { id: 'acc-eur', status: 'active', currency: 'EUR', balance_minor: 5000 } },
      'product_orders.select': { data: [] },
      'product_orders.insert': { data: [{ id: 'ord1', external_order_id: `${KEY}:it1` }] },
      'product_orders.update': { data: [] },
      'universal_cart_items.update': { data: [] },
      'shop_video_events.insert': { data: null },
    });
    mockGetSupabase.mockReturnValue(client);

    const res = await checkoutUniversalCart({ userId: USER, tenantId: TENANT, idempotencyKey: KEY });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.checkout_id).toBe(KEY);
    expect(res.wallet_order).toEqual({
      currency: 'EUR', amount_minor: 2000, balance_minor: 3000, duplicate: false, order_ids: ['ord1'],
    });
    expect(res.affiliate_redirects).toEqual([]);
    expect(res.completed_item_ids).toEqual(['it1']);
    expect(mockDebit).toHaveBeenCalledWith(expect.objectContaining({
      account_id: 'acc-eur', amount_minor: 2000, currency: 'EUR',
      reference_type: 'cart_checkout', reference_id: KEY,
    }));
  });

  it('affiliate only: no wallet debit, returns redirects, completes items', async () => {
    const { client } = makeSupabase({
      ...ACTIVE_CART,
      'universal_cart_items.select': {
        data: [{
          id: 'itA', product_id: 'pA', quantity: 1, unit_price_cents_snapshot: 2599,
          currency_snapshot: 'USD', source_surface: 'video_shop', source_video_id: 'vA',
          source_creator_id: null, item_type: 'partner_product',
        }],
      },
      'products.select': {
        data: [{ id: 'pA', source_network: 'amazon', price_cents: 2599, currency: 'USD', is_active: true, availability: 'in_stock', merchant_id: 'mA', affiliate_url: 'https://amzn.to/x' }],
      },
      'product_orders.select': { data: [] },
      'product_orders.insert': { data: [{ id: 'ordA', external_order_id: `${KEY}:itA` }] },
      'universal_cart_items.update': { data: [] },
      'shop_video_events.insert': { data: null },
    });
    mockGetSupabase.mockReturnValue(client);

    const res = await checkoutUniversalCart({ userId: USER, tenantId: TENANT, idempotencyKey: KEY });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(mockDebit).not.toHaveBeenCalled();
    expect(res.wallet_order).toBeNull();
    expect(res.affiliate_redirects).toEqual([
      { item_id: 'itA', product_id: 'pA', affiliate_url: 'https://amzn.to/x', order_id: 'ordA' },
    ]);
    expect(res.completed_item_ids).toEqual(['itA']);
  });

  it('hybrid cart: debits only the first-party total and returns affiliate redirects', async () => {
    mockDebit.mockResolvedValueOnce({ ok: true, duplicate: false, balance_minor: 1000, currency: 'EUR' });
    const { client } = makeSupabase({
      ...ACTIVE_CART,
      'universal_cart_items.select': {
        data: [
          { id: 'itF', product_id: 'pF', quantity: 1, unit_price_cents_snapshot: 1500, currency_snapshot: 'EUR', source_surface: 'video_shop', source_video_id: null, source_creator_id: null, item_type: 'supplement' },
          { id: 'itA', product_id: 'pA', quantity: 1, unit_price_cents_snapshot: 999, currency_snapshot: 'EUR', source_surface: 'video_shop', source_video_id: null, source_creator_id: null, item_type: 'partner_product' },
        ],
      },
      'products.select': {
        data: [
          { id: 'pF', source_network: 'partner', price_cents: 1500, currency: 'EUR', is_active: true, availability: 'in_stock', merchant_id: 'mF', affiliate_url: null },
          { id: 'pA', source_network: 'shopify', price_cents: 999, currency: 'EUR', is_active: true, availability: 'in_stock', merchant_id: 'mA', affiliate_url: 'https://shop/x' },
        ],
      },
      'wallet_accounts.select': { data: { id: 'acc-eur', status: 'active', currency: 'EUR', balance_minor: 5000 } },
      'product_orders.select': { data: [] },
      'product_orders.insert': { data: [{ id: 'ordF', external_order_id: `${KEY}:itF` }, { id: 'ordA', external_order_id: `${KEY}:itA` }] },
      'product_orders.update': { data: [] },
      'universal_cart_items.update': { data: [] },
      'shop_video_events.insert': { data: null },
    });
    mockGetSupabase.mockReturnValue(client);

    const res = await checkoutUniversalCart({ userId: USER, tenantId: TENANT, idempotencyKey: KEY });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(mockDebit).toHaveBeenCalledWith(expect.objectContaining({ amount_minor: 1500, currency: 'EUR' }));
    expect(res.wallet_order?.order_ids).toEqual(['ordF']);
    expect(res.affiliate_redirects).toEqual([{ item_id: 'itA', product_id: 'pA', affiliate_url: 'https://shop/x', order_id: 'ordA' }]);
    expect(res.completed_item_ids.sort()).toEqual(['itA', 'itF']);
  });

  it('insufficient balance: returns 402 code, no items completed', async () => {
    mockDebit.mockResolvedValueOnce({ ok: false, error: 'INSUFFICIENT_BALANCE', balance_minor: 100, required_minor: 2000, currency: 'EUR' });
    const { client, calls } = makeSupabase({
      ...ACTIVE_CART,
      'universal_cart_items.select': {
        data: [{ id: 'it1', product_id: 'p1', quantity: 2, unit_price_cents_snapshot: 1000, currency_snapshot: 'EUR', source_surface: null, source_video_id: null, source_creator_id: null, item_type: 'supplement' }],
      },
      'products.select': { data: [{ id: 'p1', source_network: 'manual', price_cents: 1000, currency: 'EUR', is_active: true, availability: 'in_stock', merchant_id: 'm1', affiliate_url: null }] },
      'wallet_accounts.select': { data: { id: 'acc-eur', status: 'active', currency: 'EUR', balance_minor: 100 } },
      'product_orders.select': { data: [] },
      'product_orders.insert': { data: [{ id: 'ord1', external_order_id: `${KEY}:it1` }] },
    });
    mockGetSupabase.mockReturnValue(client);

    const res = await checkoutUniversalCart({ userId: USER, tenantId: TENANT, idempotencyKey: KEY });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('INSUFFICIENT_BALANCE');
    expect(res.balance_minor).toBe(100);
    expect(res.required_minor).toBe(2000);
    // Cart items must NOT have been completed when the debit failed.
    expect(calls.some((c) => c.table === 'universal_cart_items' && c.op === 'update')).toBe(false);
  });

  it('out-of-stock line: PRODUCT_UNAVAILABLE before any debit or order write', async () => {
    const { client, calls } = makeSupabase({
      ...ACTIVE_CART,
      'universal_cart_items.select': {
        data: [{ id: 'it1', product_id: 'p1', quantity: 1, unit_price_cents_snapshot: 1000, currency_snapshot: 'EUR', source_surface: null, source_video_id: null, source_creator_id: null, item_type: 'supplement' }],
      },
      'products.select': { data: [{ id: 'p1', source_network: 'manual', price_cents: 1000, currency: 'EUR', is_active: true, availability: 'out_of_stock', merchant_id: 'm1', affiliate_url: null }] },
    });
    mockGetSupabase.mockReturnValue(client);

    const res = await checkoutUniversalCart({ userId: USER, tenantId: TENANT, idempotencyKey: KEY });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('PRODUCT_UNAVAILABLE');
    expect(res.unavailable).toEqual([{ item_id: 'it1', product_id: 'p1', reason: 'out_of_stock' }]);
    expect(mockDebit).not.toHaveBeenCalled();
    expect(calls.some((c) => c.table === 'product_orders' && c.op === 'insert')).toBe(false);
  });

  it('empty cart: CART_EMPTY', async () => {
    const { client } = makeSupabase({ ...ACTIVE_CART, 'universal_cart_items.select': { data: [] } });
    mockGetSupabase.mockReturnValue(client);
    const res = await checkoutUniversalCart({ userId: USER, tenantId: TENANT, idempotencyKey: KEY });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('CART_EMPTY');
  });

  it('no active cart: CART_EMPTY', async () => {
    const { client } = makeSupabase({ 'universal_carts.select': { data: null } });
    mockGetSupabase.mockReturnValue(client);
    const res = await checkoutUniversalCart({ userId: USER, tenantId: TENANT, idempotencyKey: KEY });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('CART_EMPTY');
  });

  it('first-party lines spanning two currencies: MIXED_CURRENCY', async () => {
    const { client } = makeSupabase({
      ...ACTIVE_CART,
      'universal_cart_items.select': {
        data: [
          { id: 'itE', product_id: 'pE', quantity: 1, unit_price_cents_snapshot: 1000, currency_snapshot: 'EUR', source_surface: null, source_video_id: null, source_creator_id: null, item_type: 'supplement' },
          { id: 'itU', product_id: 'pU', quantity: 1, unit_price_cents_snapshot: 1000, currency_snapshot: 'USD', source_surface: null, source_video_id: null, source_creator_id: null, item_type: 'supplement' },
        ],
      },
      'products.select': {
        data: [
          { id: 'pE', source_network: 'manual', price_cents: 1000, currency: 'EUR', is_active: true, availability: 'in_stock', merchant_id: 'mE', affiliate_url: null },
          { id: 'pU', source_network: 'manual', price_cents: 1000, currency: 'USD', is_active: true, availability: 'in_stock', merchant_id: 'mU', affiliate_url: null },
        ],
      },
    });
    mockGetSupabase.mockReturnValue(client);
    const res = await checkoutUniversalCart({ userId: USER, tenantId: TENANT, idempotencyKey: KEY });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('MIXED_CURRENCY');
    expect(mockDebit).not.toHaveBeenCalled();
  });

  it('missing wallet account for the currency: WALLET_ACCOUNT_MISSING', async () => {
    const { client } = makeSupabase({
      ...ACTIVE_CART,
      'universal_cart_items.select': {
        data: [{ id: 'it1', product_id: 'p1', quantity: 1, unit_price_cents_snapshot: 1000, currency_snapshot: 'EUR', source_surface: null, source_video_id: null, source_creator_id: null, item_type: 'supplement' }],
      },
      'products.select': { data: [{ id: 'p1', source_network: 'manual', price_cents: 1000, currency: 'EUR', is_active: true, availability: 'in_stock', merchant_id: 'm1', affiliate_url: null }] },
      'wallet_accounts.select': { data: null },
    });
    mockGetSupabase.mockReturnValue(client);
    const res = await checkoutUniversalCart({ userId: USER, tenantId: TENANT, idempotencyKey: KEY });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('WALLET_ACCOUNT_MISSING');
    expect(mockDebit).not.toHaveBeenCalled();
  });

  it('missing tenant: TENANT_REQUIRED', async () => {
    mockGetSupabase.mockReturnValue(makeSupabase({}).client);
    const res = await checkoutUniversalCart({ userId: USER, tenantId: null, idempotencyKey: KEY });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('TENANT_REQUIRED');
  });

  it('gateway misconfigured: GATEWAY_MISCONFIGURED', async () => {
    mockGetSupabase.mockReturnValue(null);
    const res = await checkoutUniversalCart({ userId: USER, tenantId: TENANT, idempotencyKey: KEY });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('GATEWAY_MISCONFIGURED');
  });
});
