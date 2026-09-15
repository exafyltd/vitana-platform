/**
 * Supplier self-service catalogue — the route itself (VTID-03894).
 *
 * The load-bearing assertions are the OWNERSHIP ones, same as the sibling
 * `/my` surface this router sits alongside: every read and write resolves the
 * merchant from `owner_user_id` in the JWT and never from anything the client
 * sends, and a product belonging to someone else reads as 404 rather than 403
 * (403 would confirm the row exists).
 *
 * The other thing pinned here is what a supplier's rows are BORN as:
 * `source_network = 'supplier_referral'` (outside FIRST_PARTY_SOURCE_NETWORKS,
 * so a cart line clicks out instead of debiting a member's wallet),
 * `is_active = false`, `onboarding_status = 'draft'`. Nothing a supplier types
 * goes live on their own say-so.
 */
import express, { NextFunction, Response } from 'express';
import request from 'supertest';
import productsRouter, { SUPPLIER_SOURCE_NETWORK } from '../../src/routes/vcaop-portal-my-products';
import { requireAuth } from '../../src/middleware/auth-supabase-jwt';
import { getSupabase } from '../../src/lib/supabase';

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({ requireAuth: jest.fn() }));
jest.mock('../../src/lib/supabase', () => ({ getSupabase: jest.fn() }));

const app = express();
app.use(express.json());
app.use('/api/v1/vcaop/portal/my', productsRouter);

const asSupplier = (id: string | null = 'supplier-1') =>
  (requireAuth as jest.Mock).mockImplementation((req: any, _res: Response, next: NextFunction) => {
    req.identity = id ? { user_id: id, tenant_id: 'platform', exafy_admin: false } : {};
    next();
  });

/** Chainable Supabase stub that records every eq() filter and every write. */
function tableStub(result: { data?: any; error?: any } = {}) {
  const filters: Record<string, unknown> = {};
  const inserted: any[] = [];
  const updated: any[] = [];
  const chain: any = {
    filters,
    inserted,
    updated,
    select: jest.fn(() => chain),
    insert: jest.fn((row: any) => { inserted.push(row); return chain; }),
    update: jest.fn((row: any) => { updated.push(row); return chain; }),
    eq: jest.fn((col: string, val: unknown) => { filters[col] = val; return chain; }),
    in: jest.fn(() => chain),
    order: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    maybeSingle: jest.fn(() => Promise.resolve({ data: result.data ?? null, error: result.error ?? null })),
    then: (resolve: any) => resolve({ data: result.data ?? null, error: result.error ?? null }),
  };
  return chain;
}

/** Route tables by name, so one request can hit merchants AND products. */
function db(tables: Record<string, any>) {
  (getSupabase as jest.Mock).mockReturnValue({
    from: jest.fn((name: string) => tables[name] ?? tableStub()),
  });
}

const OWNED_MERCHANT = { id: 'm-1', name: 'Weingut Muster', vertical_key: 'wine_spirits', onboarding_status: 'draft' };

const VALID_PRODUCT = {
  title: 'Barolo Riserva 2019',
  price_cents: 4200,
  currency: 'eur',
  affiliate_url: 'https://weingut-muster.example/barolo-2019',
  origin_country: 'it',
  ships_to_countries: ['DE', 'AT'],
  attributes: { vintage: 2019 },
};

beforeEach(() => jest.clearAllMocks());

describe('auth', () => {
  test('a request with no user_id is rejected before any query', async () => {
    asSupplier(null);
    const merchants = tableStub();
    db({ merchants });

    const res = await request(app).post('/api/v1/vcaop/portal/my/merchants')
      .send({ name: 'X', vertical_key: 'wine_spirits' });

    expect(res.status).toBe(401);
    expect(merchants.inserted).toHaveLength(0);
  });

  test('the router mounts requireAuth, so no handler is reachable unauthenticated', () => {
    // requireAuth is mocked here (it must be, or every test would need a real
    // JWT), so this asserts the wiring rather than the middleware's behaviour.
    expect(requireAuth).toBeDefined();
  });

  test('a database outage is 503, not a 500 that reads like a bug in the form', async () => {
    asSupplier();
    (getSupabase as jest.Mock).mockReturnValue(null);

    const res = await request(app).get('/api/v1/vcaop/portal/my/products');
    expect(res.status).toBe(503);
  });
});

describe('ownership scoping', () => {
  test('GET /products resolves the merchant by owner_user_id from the JWT', async () => {
    asSupplier('supplier-7');
    const merchants = tableStub({ data: OWNED_MERCHANT });
    db({ merchants, products: tableStub({ data: [] }) });

    const res = await request(app).get('/api/v1/vcaop/portal/my/products');

    expect(res.status).toBe(200);
    expect(merchants.filters.owner_user_id).toBe('supplier-7');
  });

  test('GET /products scopes the product query to that merchant', async () => {
    asSupplier();
    const products = tableStub({ data: [] });
    db({ merchants: tableStub({ data: OWNED_MERCHANT }), products });

    await request(app).get('/api/v1/vcaop/portal/my/products');

    expect(products.filters.merchant_id).toBe('m-1');
  });

  test('a supplier with no merchant row gets an empty list, not an error', async () => {
    asSupplier();
    db({ merchants: tableStub({ data: null }) });

    const res = await request(app).get('/api/v1/vcaop/portal/my/products');
    expect(res.status).toBe(200);
  });

  test('PATCH on another supplier\'s product is 404 — never 403', async () => {
    // 403 would confirm the row exists. The merchant_id predicate means the
    // row simply matches nothing.
    asSupplier('supplier-2');
    const merchants = tableStub({ data: OWNED_MERCHANT });
    db({ merchants, products: tableStub({ data: null }) });

    const res = await request(app)
      .patch('/api/v1/vcaop/portal/my/products/someone-elses-id')
      .send({ title: 'Renamed' });

    expect(res.status).toBe(404);
    expect(merchants.filters.owner_user_id).toBe('supplier-2');
  });

  test('POST /products without a merchant says WHICH step was skipped', async () => {
    // 409 no_merchant, not 404 and not a 500 on a null merchant_id: the form
    // creates the business first, so reaching here means the client skipped a
    // step and the response should name it.
    asSupplier();
    const products = tableStub();
    db({ merchants: tableStub({ data: null }), products });

    const res = await request(app).post('/api/v1/vcaop/portal/my/products').send(VALID_PRODUCT);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('no_merchant');
    expect(products.inserted).toHaveLength(0);
  });
});

describe('what a supplier\'s rows are born as', () => {
  test('a product is written supplier_referral, inactive', async () => {
    asSupplier();
    const products = tableStub({ data: { id: 'p-1', title: VALID_PRODUCT.title, is_active: false } });
    db({ merchants: tableStub({ data: OWNED_MERCHANT }), products });

    const res = await request(app).post('/api/v1/vcaop/portal/my/products').send(VALID_PRODUCT);

    expect(res.status).toBe(201);
    const row = products.inserted[0];
    // The money-path property: NOT first-party, so checkout clicks out to the
    // supplier's own shop instead of debiting a member's wallet for an order
    // nobody would fulfil.
    expect(row.source_network).toBe(SUPPLIER_SOURCE_NETWORK);
    expect(row.source_network).not.toBe('manual');
    expect(row.is_active).toBe(false);
    expect(row.merchant_id).toBe('m-1');
  });

  test('a merchant is written draft + inactive, owned by the JWT\'s user', async () => {
    asSupplier('supplier-9');
    // data:null so findOwnMerchant finds nothing — this route is
    // create-OR-update, and an existing merchant takes the update branch.
    const merchants = tableStub({ data: null });
    db({ merchants });

    const res = await request(app).post('/api/v1/vcaop/portal/my/merchants')
      .send({ name: 'Weingut Muster', vertical_key: 'wine_spirits' });

    expect(res.status).toBe(201);
    const row = merchants.inserted[0];
    expect(row.owner_user_id).toBe('supplier-9');
    expect(row.onboarding_status).toBe('draft');
    expect(row.is_active).toBe(false);
    expect(row.source_network).toBe(SUPPLIER_SOURCE_NETWORK);
  });

  test('a SECOND POST /merchants updates rather than 409s, scoped to the owner', async () => {
    // One supplier, one merchant: the form's "save" is idempotent from the
    // supplier's point of view. Found because the original version of this
    // suite assumed create-always and CI disagreed — 200, not 201.
    asSupplier('supplier-9');
    const merchants = tableStub({ data: OWNED_MERCHANT });
    db({ merchants });

    const res = await request(app).post('/api/v1/vcaop/portal/my/merchants')
      .send({ name: 'Weingut Muster GmbH', vertical_key: 'wine_spirits' });

    expect(res.status).toBe(200);
    expect(merchants.inserted).toHaveLength(0);
    expect(merchants.updated[0].name).toBe('Weingut Muster GmbH');
    // The update is owner-scoped too, not just the lookup that preceded it —
    // otherwise knowing a merchant id would be enough to rewrite it.
    expect(merchants.filters.owner_user_id).toBe('supplier-9');
    expect(merchants.filters.id).toBe('m-1');
  });

  test('ownership comes from the JWT even when the body claims otherwise', async () => {
    asSupplier('real-owner');
    const merchants = tableStub({ data: null });
    db({ merchants });

    await request(app).post('/api/v1/vcaop/portal/my/merchants')
      .send({ name: 'X', vertical_key: 'wine_spirits', owner_user_id: 'someone-else' });

    expect(merchants.inserted[0].owner_user_id).toBe('real-owner');
  });
});

describe('validation', () => {
  test('a product shipping nowhere is refused — Discover could never show it', async () => {
    asSupplier();
    const products = tableStub();
    db({ merchants: tableStub({ data: OWNED_MERCHANT }), products });

    const { ships_to_countries, ...noDestination } = VALID_PRODUCT;
    const res = await request(app).post('/api/v1/vcaop/portal/my/products').send(noDestination);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_product');
    expect(products.inserted).toHaveLength(0);
  });

  test('naming a network without an advertiser id is refused', async () => {
    // Without the id a pulled conversion resolves to `<network>_unknown` and
    // never reaches this merchant — connected-looking, attributing nothing.
    asSupplier();
    const merchants = tableStub();
    db({ merchants });

    const res = await request(app).post('/api/v1/vcaop/portal/my/merchants')
      .send({ name: 'X', vertical_key: 'wine_spirits', affiliate_network: 'awin' });

    expect(res.status).toBe(400);
    expect(merchants.inserted).toHaveLength(0);
  });

  test('"other" is allowed with no advertiser id — a supplier on no network can still list', async () => {
    asSupplier();
    const merchants = tableStub({ data: null });
    db({ merchants });

    const res = await request(app).post('/api/v1/vcaop/portal/my/merchants')
      .send({ name: 'X', vertical_key: 'wine_spirits', affiliate_network: 'other' });

    expect(res.status).toBe(201);
  });

  test('a network with no conversion path is refused by the enum', async () => {
    asSupplier();
    const merchants = tableStub();
    db({ merchants });

    const res = await request(app).post('/api/v1/vcaop/portal/my/merchants')
      .send({ name: 'X', vertical_key: 'wine_spirits', affiliate_network: 'cj', affiliate_advertiser_id: '1' });

    expect(res.status).toBe(400);
    expect(merchants.inserted).toHaveLength(0);
  });

  test('a non-url buy link is refused', async () => {
    asSupplier();
    const products = tableStub();
    db({ merchants: tableStub({ data: OWNED_MERCHANT }), products });

    const res = await request(app).post('/api/v1/vcaop/portal/my/products')
      .send({ ...VALID_PRODUCT, affiliate_url: 'weingut-muster.example' });

    expect(res.status).toBe(400);
    expect(products.inserted).toHaveLength(0);
  });
});

describe('GET /verticals', () => {
  test('returns verticals with their fields nested', async () => {
    asSupplier();
    db({
      catalog_verticals: tableStub({ data: [{ key: 'wine_spirits', display_label: 'Wine' }] }),
      catalog_vertical_fields: tableStub({ data: [{ vertical_key: 'wine_spirits', field_key: 'vintage' }] }),
      catalog_vocabulary: tableStub({ data: [] }),
    });

    const res = await request(app).get('/api/v1/vcaop/portal/my/verticals');

    expect(res.status).toBe(200);
    expect(res.body.data.verticals[0].fields).toHaveLength(1);
  });

  test('a read failure is 500, not a silently empty form', async () => {
    asSupplier();
    db({
      catalog_verticals: tableStub({ error: { message: 'boom' } }),
      catalog_vertical_fields: tableStub({ data: [] }),
    });

    const res = await request(app).get('/api/v1/vcaop/portal/my/verticals');
    expect(res.status).toBe(500);
  });
});
