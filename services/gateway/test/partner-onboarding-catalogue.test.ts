/**
 * VTID-04488 — HTTP tests for the onboarding catalogue step
 * (/api/v1/partner-onboarding/:orgId/catalogue/*).
 *
 * Contract: org_admin only; one merchant per org (created, or adopted from the
 * owner's unlinked portal merchant); products are drafts (`is_active: false`)
 * validated by the supplier portal's own schemas; the catalogue step row is
 * written after every change and an OASIS event fires only when its status
 * moves; locked for rejected and suspended orgs.
 */

import express from 'express';
import request from 'supertest';

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const byToken: Record<string, any> = {
      'Bearer owner-1': { user_id: 'owner-1', email: 'ann@acme.example', exafy_admin: false },
      'Bearer other-1': { user_id: 'other-1', email: 'x@example.com', exafy_admin: false },
    };
    const id = byToken[req.headers.authorization];
    if (!id) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    req.identity = id;
    return next();
  },
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

const emitOasisEventMock = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: any[]) => emitOasisEventMock(...args),
}));
jest.mock('../src/services/platform-detect', () => ({ detectPlatform: jest.fn(), ssrfGuardedFetch: jest.fn() }));
jest.mock('../src/i18n/server-locale', () => ({ getUserLocale: jest.fn().mockResolvedValue('de') }));
jest.mock('../src/services/email/partner-invite-email', () => {
  const actual = jest.requireActual('../src/services/email/partner-invite-email');
  return { ...actual, sendPartnerInviteEmail: jest.fn().mockResolvedValue({ sent: false, status: 'disabled' }) };
});

type Call = { table: string; op: string; args: any[]; filters: Array<[string, any]>; terminal: string };
let handlers: Record<string, (c: Call) => any>;
let calls: Call[];

function makeFakeSupabase() {
  return {
    from(table: string) {
      let op = 'select';
      let args: any[] = [];
      const filters: Array<[string, any]> = [];
      const run = (terminal: string) => {
        const call = { table, op, args, filters, terminal };
        calls.push(call);
        const h = handlers[table];
        if (!h) throw new Error(`Unexpected table in test: ${table}`);
        return Promise.resolve(h(call));
      };
      const chain: any = {};
      chain.eq = (col: string, val: any) => { filters.push([col, val]); return chain; };
      chain.is = (col: string, val: any) => { filters.push([`is:${col}`, val]); return chain; };
      for (const m of ['order', 'limit', 'in']) chain[m] = () => chain;
      chain.select = (...a: any[]) => { if (op === 'select') args = a; return chain; };
      chain.insert = (...a: any[]) => { op = 'insert'; args = a; return chain; };
      chain.update = (...a: any[]) => { op = 'update'; args = a; return chain; };
      chain.upsert = (...a: any[]) => { op = 'upsert'; args = a; return chain; };
      chain.maybeSingle = () => run('maybeSingle');
      chain.single = () => run('single');
      chain.then = (res: any, rej: any) => run('then').then(res, rej);
      return chain;
    },
  };
}
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => makeFakeSupabase() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../src/routes/partner-onboarding-catalogue').default;

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/partner-onboarding', router);
  return a;
}

const BASE = '/api/v1/partner-onboarding/org-1/catalogue';

const PRODUCT = {
  title: 'Omega 3',
  price_cents: 1999,
  currency: 'eur',
  affiliate_url: 'https://acme.example/p/omega',
  origin_country: 'de',
  ships_to_countries: ['DE'],
};

interface World {
  org: Record<string, any>;
  merchant: Record<string, any> | null;
  legacy: Record<string, any> | null;
  products: any[];
  priorStep: string | null;
  admin: boolean;
}

function wire(over: Partial<World> = {}): World {
  const w: World = {
    org: {
      id: 'org-1', org_key: 'acme-abc123', display_name: 'Acme', partner_type: 'supplier_shop', commerce_vertical: 'general',
      lifecycle_state: 'draft', status: 'pending_review', trust_level: 0, legal_name: 'Acme GmbH', country: 'DE',
      vat_id: 'DE123456789', website: 'https://acme.example/', owner_user_id: 'owner-1', created_at: '2026-09-24T00:00:00Z',
    },
    merchant: null,
    legacy: null,
    products: [],
    priorStep: null,
    admin: true,
    ...over,
  };
  handlers.partner_organizations = () => ({ data: { ...w.org }, error: null });
  handlers.partner_organization_members = (c) =>
    c.terminal === 'maybeSingle' ? { data: w.admin ? { role: 'org_admin' } : null, error: null } : { data: null, count: 1, error: null };
  handlers.merchants = (c) => {
    const byOrg = c.filters.find(([k]) => k === 'partner_organization_id');
    if (c.op === 'insert') {
      w.merchant = { ...c.args[0] };
      return { data: { ...w.merchant }, error: null };
    }
    if (c.op === 'update') {
      if (byOrg && w.merchant) { Object.assign(w.merchant, c.args[0]); return { data: { ...w.merchant }, error: null }; }
      if (w.legacy) { w.merchant = { ...w.legacy, ...c.args[0] }; w.legacy = null; return { data: { ...w.merchant }, error: null }; }
      return { data: null, error: null };
    }
    if (byOrg) return { data: w.merchant ? { ...w.merchant } : null, error: null };
    return { data: w.legacy ? { id: w.legacy.id } : null, error: null };
  };
  handlers.products = (c) => {
    if (c.op === 'insert') { w.products.push({ ...c.args[0] }); return { data: { ...c.args[0] }, error: null }; }
    if (c.op === 'update') {
      const id = c.filters.find(([k]) => k === 'id')?.[1];
      const p = w.products.find((x) => x.id === id);
      if (!p) return { data: null, error: null };
      Object.assign(p, c.args[0]);
      return { data: { ...p }, error: null };
    }
    if (c.terminal === 'maybeSingle') {
      const id = c.filters.find(([k]) => k === 'id')?.[1];
      const p = w.products.find((x) => x.id === id);
      return { data: p ? { ships_to_countries: p.ships_to_countries ?? null, ships_to_regions: p.ships_to_regions ?? null } : null, error: null };
    }
    if (c.args[1]?.head) return { data: null, count: w.products.length, error: null };
    return { data: w.products, error: null };
  };
  handlers.partner_onboarding_steps = (c) => {
    if (c.op === 'upsert') { w.priorStep = c.args[0].status; return { data: null, error: null }; }
    if (c.terminal === 'maybeSingle') return { data: w.priorStep ? { status: w.priorStep } : null, error: null };
    return { data: w.priorStep ? [{ step_key: 'catalogue', status: w.priorStep, detail: {} }] : [], error: null };
  };
  handlers.partner_terms_acceptances = () => ({ data: [], error: null });
  return w;
}

const stepUpserts = () => calls.filter((c) => c.table === 'partner_onboarding_steps' && c.op === 'upsert');

beforeEach(() => {
  jest.clearAllMocks();
  handlers = {};
  calls = [];
});

describe('access', () => {
  it('401 JSON without a token', async () => {
    const r = await request(app()).get(BASE);
    expect(r.status).toBe(401);
    expect(r.type).toBe('application/json');
  });

  it('is org_admin only', async () => {
    wire({ admin: false });
    const r = await request(app()).put(`${BASE}/merchant`).set('Authorization', 'Bearer other-1').send({});
    expect(r.status).toBe(403);
    expect(calls.some((c) => c.table === 'merchants')).toBe(false);
  });

  it('409 CATALOGUE_LOCKED for a rejected org, before any write', async () => {
    const w = wire();
    w.org.lifecycle_state = 'rejected';
    const r = await request(app()).put(`${BASE}/merchant`).set('Authorization', 'Bearer owner-1').send({ vertical_key: 'supplements' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('CATALOGUE_LOCKED');
    expect(calls.some((c) => c.table === 'merchants' && c.op !== 'select')).toBe(false);
  });
});

describe('PUT /:orgId/catalogue/merchant', () => {
  it('a shop must pick a vertical', async () => {
    wire();
    const r = await request(app()).put(`${BASE}/merchant`).set('Authorization', 'Bearer owner-1').send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_merchant');
  });

  it('creates the org merchant from the company facts, as a hidden draft, and moves the step to in_progress', async () => {
    const w = wire();
    const r = await request(app()).put(`${BASE}/merchant`).set('Authorization', 'Bearer owner-1').send({ vertical_key: 'supplements' });
    expect(r.status).toBe(201);
    expect(r.body.created).toBe(true);
    expect(w.merchant).toMatchObject({
      name: 'Acme',
      vertical_key: 'supplements',
      merchant_country: 'DE',
      storefront_url: 'https://acme.example/',
      partner_organization_id: 'org-1',
      source_network: 'supplier_referral',
      source_merchant_id: 'supplier_referral:org:org-1',
      onboarding_status: 'draft',
      is_active: false,
    });
    expect(w.merchant!.owner_user_id).toBeUndefined();
    expect(stepUpserts()[0].args[0]).toMatchObject({ step_key: 'catalogue', status: 'in_progress' });
    expect(emitOasisEventMock).toHaveBeenCalledTimes(1);
    expect(emitOasisEventMock.mock.calls[0][0]).toMatchObject({
      type: 'partner_org.catalogue_step_changed',
      payload: { partner_organization_id: 'org-1', from: null, to: 'in_progress', product_count: 0 },
    });
  });

  it('a lab defaults to the diagnostics vertical', async () => {
    const w = wire();
    w.org.partner_type = 'lab';
    const r = await request(app()).put(`${BASE}/merchant`).set('Authorization', 'Bearer owner-1').send({});
    expect(r.status).toBe(201);
    expect(w.merchant!.vertical_key).toBe('diagnostics');
  });

  it("adopts the owner's unlinked portal merchant instead of creating a second one", async () => {
    const w = wire({ legacy: { id: 'm-legacy', name: 'Old', vertical_key: 'supplements', onboarding_status: 'draft' } });
    const r = await request(app()).put(`${BASE}/merchant`).set('Authorization', 'Bearer owner-1').send({ vertical_key: 'supplements' });
    expect(r.status).toBe(200);
    expect(r.body.adopted).toBe(true);
    expect(calls.some((c) => c.table === 'merchants' && c.op === 'insert')).toBe(false);
    const upd = calls.find((c) => c.table === 'merchants' && c.op === 'update')!;
    expect(upd.args[0].partner_organization_id).toBe('org-1');
    expect(upd.filters).toContainEqual(['is:partner_organization_id', null]);
    expect(w.merchant!.id).toBe('m-legacy');
  });

  it('updates the existing org merchant and emits nothing when the step does not move', async () => {
    const w = wire({ merchant: { id: 'm-1', name: 'Acme', partner_organization_id: 'org-1' }, priorStep: 'in_progress' });
    const r = await request(app()).put(`${BASE}/merchant`).set('Authorization', 'Bearer owner-1').send({ vertical_key: 'apparel', name: 'Acme Store' });
    expect(r.status).toBe(200);
    expect(w.merchant).toMatchObject({ id: 'm-1', name: 'Acme Store', vertical_key: 'apparel' });
    expect(emitOasisEventMock).not.toHaveBeenCalled();
  });
});

describe('products', () => {
  it('409 NO_MERCHANT before the merchant exists', async () => {
    wire();
    const r = await request(app()).post(`${BASE}/products`).set('Authorization', 'Bearer owner-1').send(PRODUCT);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('NO_MERCHANT');
  });

  it('rejects a product that ships nowhere', async () => {
    wire({ merchant: { id: 'm-1', partner_organization_id: 'org-1' } });
    const r = await request(app()).post(`${BASE}/products`).set('Authorization', 'Bearer owner-1')
      .send({ ...PRODUCT, ships_to_countries: [] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_product');
  });

  it('adds a draft product under the org merchant and completes the catalogue step', async () => {
    const w = wire({ merchant: { id: 'm-1', partner_organization_id: 'org-1' }, priorStep: 'in_progress' });
    const r = await request(app()).post(`${BASE}/products`).set('Authorization', 'Bearer owner-1').send({ ...PRODUCT, is_active: true });
    expect(r.status).toBe(201);
    expect(w.products[0]).toMatchObject({ merchant_id: 'm-1', source_network: 'supplier_referral', currency: 'EUR', origin_country: 'DE', is_active: false });
    expect(stepUpserts()[0].args[0]).toMatchObject({ status: 'done', detail: { merchant_id: 'm-1', product_count: 1 } });
    expect(emitOasisEventMock.mock.calls[0][0].payload).toMatchObject({ from: 'in_progress', to: 'done', product_count: 1 });
    expect(r.body.checklist.steps.find((s: any) => s.key === 'catalogue').status).toBe('done');
  });

  it("PATCH changes the org's own product and 404s another's", async () => {
    const w = wire({
      merchant: { id: 'm-1', partner_organization_id: 'org-1' },
      products: [{ id: 'p-1', merchant_id: 'm-1', title: 'Old', ships_to_countries: ['DE'] }],
      priorStep: 'done',
    });
    const ok = await request(app()).patch(`${BASE}/products/p-1`).set('Authorization', 'Bearer owner-1').send({ title: 'New' });
    expect(ok.status).toBe(200);
    expect(w.products[0].title).toBe('New');
    const upd = calls.find((c) => c.table === 'products' && c.op === 'update')!;
    expect(upd.filters).toContainEqual(['merchant_id', 'm-1']);

    const missing = await request(app()).patch(`${BASE}/products/p-other`).set('Authorization', 'Bearer owner-1').send({ title: 'X' });
    expect(missing.status).toBe(404);
    expect(emitOasisEventMock).not.toHaveBeenCalled();
  });

  it('PATCH judges ships-to against the merged product', async () => {
    wire({
      merchant: { id: 'm-1', partner_organization_id: 'org-1' },
      products: [{ id: 'p-1', merchant_id: 'm-1', ships_to_countries: ['DE'], ships_to_regions: null }],
    });
    const r = await request(app()).patch(`${BASE}/products/p-1`).set('Authorization', 'Bearer owner-1').send({ ships_to_countries: [] });
    expect(r.status).toBe(400);
    expect(calls.some((c) => c.table === 'products' && c.op === 'update')).toBe(false);
  });
});

describe('GET /:orgId/catalogue', () => {
  it('returns the merchant and its products', async () => {
    wire({ merchant: { id: 'm-1', name: 'Acme', partner_organization_id: 'org-1' }, products: [{ id: 'p-1', title: 'A' }] });
    const r = await request(app()).get(BASE).set('Authorization', 'Bearer owner-1');
    expect(r.status).toBe(200);
    expect(r.body.merchant.id).toBe('m-1');
    expect(r.body.products).toHaveLength(1);
  });

  it('empty before the merchant exists', async () => {
    wire();
    const r = await request(app()).get(BASE).set('Authorization', 'Bearer owner-1');
    expect(r.body).toEqual({ ok: true, merchant: null, products: [] });
  });
});
