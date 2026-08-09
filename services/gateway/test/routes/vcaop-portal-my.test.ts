/**
 * VCAOP merchant self-service portal — /my surface (VTID-03553).
 *
 * The load-bearing assertions are the OWNERSHIP ones: every read filters on
 * partner_tenant.owner_user_id = the caller, creation stamps ownership from
 * the JWT (never the body), and the platform's one-approval activation
 * endpoint does not exist on this surface at all.
 */
import express, { NextFunction, Response } from 'express';
import request from 'supertest';
import vcaopPortalMyRouter from '../../src/routes/vcaop-portal-my';
import { requireAuth } from '../../src/middleware/auth-supabase-jwt';
import { getSupabase } from '../../src/lib/supabase';

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({ requireAuth: jest.fn() }));
jest.mock('../../src/lib/supabase', () => ({ getSupabase: jest.fn() }));

const app = express();
app.use(express.json());
app.use('/api/v1/vcaop/portal/my', vcaopPortalMyRouter);

const asMerchant = (id = 'merchant-1', email: string | null = 'owner@example.test') =>
  (requireAuth as jest.Mock).mockImplementation((req: any, _res: Response, next: NextFunction) => {
    req.identity = { user_id: id, tenant_id: 'platform', email, exafy_admin: false };
    next();
  });

/** Chainable Supabase query stub that records every eq() filter applied. */
function tableStub(result: { data?: any; error?: any }) {
  const filters: Record<string, unknown> = {};
  const chain: any = {
    filters,
    select: jest.fn(() => chain),
    insert: jest.fn(() => Promise.resolve({ error: null })),
    update: jest.fn(() => chain),
    eq: jest.fn((col: string, val: unknown) => { filters[col] = val; return chain; }),
    is: jest.fn(() => chain),
    order: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    maybeSingle: jest.fn(() => Promise.resolve({ data: result.data ?? null, error: result.error ?? null })),
    then: (resolve: any) => resolve({ data: result.data ?? null, error: result.error ?? null }),
  };
  return chain;
}

beforeEach(() => jest.clearAllMocks());

describe('ownership scoping', () => {
  test('GET /connections filters on partner_tenant.owner_user_id = the caller', async () => {
    asMerchant('merchant-1');
    const manifests = tableStub({ data: [] });
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn(() => manifests) });
    const res = await request(app).get('/api/v1/vcaop/portal/my/connections');
    expect(res.status).toBe(200);
    expect(manifests.filters['partner_tenant.owner_user_id']).toBe('merchant-1');
  });

  test('a connection owned by someone else reads as 404, not 403', async () => {
    asMerchant('merchant-2');
    const manifests = tableStub({ data: null }); // owner filter excludes the row
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn(() => manifests) });
    const res = await request(app).get('/api/v1/vcaop/portal/my/connections/some-id');
    expect(res.status).toBe(404);
    expect(manifests.filters['partner_tenant.owner_user_id']).toBe('merchant-2');
  });

  test('create stamps owner_user_id + owner_email from the JWT, never the body', async () => {
    asMerchant('merchant-3', 'real@owner.test');
    const inserted: any[] = [];
    const partnerLookup = tableStub({ data: null });
    const tables: Record<string, any> = {
      partner_tenant: {
        ...partnerLookup,
        insert: jest.fn((row: any) => { inserted.push(row); return Promise.resolve({ error: null }); }),
      },
      integration_manifest: { insert: jest.fn(() => Promise.resolve({ error: null })) },
      oasis_events: { insert: jest.fn(() => Promise.resolve({ error: null })) },
    };
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn((t: string) => tables[t] ?? tableStub({})) });
    const res = await request(app).post('/api/v1/vcaop/portal/my/connections').send({
      name: 'My Shop', connector_id: 'shopify', provider_id: 'shopify',
      owner_user_id: 'spoofed-user', owner_email: 'spoofed@evil.test',
    });
    expect(res.status).toBe(201);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].owner_user_id).toBe('merchant-3');
    expect(inserted[0].owner_email).toBe('real@owner.test');
  });
});

describe('authority boundaries', () => {
  test('no /approve-activation on the merchant surface — activation stays admin-only', async () => {
    asMerchant();
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn(() => tableStub({})) });
    const res = await request(app).post('/api/v1/vcaop/portal/my/connections/x/approve-activation');
    expect(res.status).toBe(404); // Express default: route does not exist
  });

  test('activation-summary reports awaiting_platform_approval instead of can_activate', async () => {
    asMerchant('merchant-1');
    const rec = { id: 'm-1', status: 'certified', partner_tenant: { name: 'Shop', owner_user_id: 'merchant-1' } };
    const version = { id: 'v-1', version: '0.1.0', certification_status: 'certified' };
    const cert = { id: 'c-1', status: 'certified' };
    const tables: Record<string, any> = {
      integration_manifest: tableStub({ data: rec }),
      integration_version: tableStub({ data: version }),
      connector_certification: tableStub({ data: cert }),
    };
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn((t: string) => tables[t] ?? tableStub({})) });
    const res = await request(app).get('/api/v1/vcaop/portal/my/connections/m-1/activation-summary');
    expect(res.status).toBe(200);
    expect(res.body.data.awaiting_platform_approval).toBe(true);
    expect(res.body.data).not.toHaveProperty('can_activate');
  });
});

describe('input + infrastructure guards', () => {
  test('database unavailable → 503, not a crash', async () => {
    asMerchant();
    (getSupabase as jest.Mock).mockReturnValue(null);
    const res = await request(app).get('/api/v1/vcaop/portal/my/connections');
    expect(res.status).toBe(503);
  });

  test('create validates required fields before touching the database', async () => {
    asMerchant();
    (getSupabase as jest.Mock).mockReturnValue({ from: jest.fn(() => tableStub({})) });
    const res = await request(app).post('/api/v1/vcaop/portal/my/connections').send({ name: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/connector_id/);
  });

  test('lifecycle transition on a foreign connection is 404 and writes nothing', async () => {
    asMerchant('merchant-9');
    const update = jest.fn();
    const manifests = tableStub({ data: null });
    (getSupabase as jest.Mock).mockReturnValue({
      from: jest.fn(() => ({ ...manifests, update })),
    });
    const res = await request(app).post('/api/v1/vcaop/portal/my/connections/foreign/revoke');
    expect(res.status).toBe(404);
    expect(update).not.toHaveBeenCalled();
  });
});
