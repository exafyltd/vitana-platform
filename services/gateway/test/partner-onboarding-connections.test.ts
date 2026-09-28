/**
 * VTID-04499 — HTTP tests for the onboarding connections step
 * (/api/v1/partner-onboarding/:orgId/connections).
 *
 * Contract: org_admin only; one partner_tenant per org (partner_organization_id,
 * owner = the org owner); the connection is created by the portal's own
 * insertConnection() into the same state machine; the connector defaults to the
 * org's website detection; the mapping step is reconciled from connection
 * states and written only when it moves; locked for rejected/suspended orgs.
 */

import express from 'express';
import request from 'supertest';

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const byToken: Record<string, any> = {
      'Bearer owner-1': { user_id: 'owner-1', email: 'ann@acme.example', tenant_id: 'maxina', exafy_admin: false },
      'Bearer admin-2': { user_id: 'admin-2', email: 'bob@acme.example', tenant_id: 'maxina', exafy_admin: false },
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
const { default: router, mappingStepStatus } = require('../src/routes/partner-onboarding-connections');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/partner-onboarding', router);
  return a;
}

const BASE = '/api/v1/partner-onboarding/org-1/connections';

interface World {
  org: Record<string, any>;
  businessDetails: Record<string, any>;
  partnerTenant: Record<string, any> | null;
  manifests: any[];
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
    businessDetails: {},
    partnerTenant: null,
    manifests: [],
    priorStep: null,
    admin: true,
    ...over,
  };
  handlers.partner_organizations = (c) =>
    c.args[0] === 'business_details'
      ? { data: { business_details: w.businessDetails }, error: null }
      : { data: { ...w.org }, error: null };
  handlers.partner_organization_members = (c) =>
    c.terminal === 'maybeSingle' ? { data: w.admin ? { role: 'org_admin' } : null, error: null } : { data: null, count: 1, error: null };
  handlers.partner_tenant = (c) => {
    if (c.op === 'insert') { w.partnerTenant = { ...c.args[0] }; return { data: null, error: null }; }
    return { data: w.partnerTenant ? { id: w.partnerTenant.id } : null, error: null };
  };
  const orgOf = (m: any) => m.org ?? 'org-1';
  const filter = (c: Call, key: string) => c.filters.find(([k]) => k === key)?.[1];
  handlers.integration_manifest = (c) => {
    if (c.op === 'insert') {
      w.manifests.push({ ...c.args[0], partner_tenant: { name: w.partnerTenant?.name, jurisdiction: w.partnerTenant?.jurisdiction } });
      return { data: null, error: null };
    }
    if (c.op === 'update') {
      const m = w.manifests.find((x) => x.id === filter(c, 'id'));
      if (m) Object.assign(m, c.args[0]);
      return { data: null, error: null };
    }
    const org = filter(c, 'partner_tenant.partner_organization_id');
    if (c.terminal === 'maybeSingle') {
      const m = w.manifests.find((x) => x.id === filter(c, 'id') && orgOf(x) === org);
      return { data: m ? { ...m } : null, error: null };
    }
    return { data: w.manifests.filter((x) => orgOf(x) === org), error: null };
  };
  handlers.oasis_events = () => ({ data: null, error: null });
  handlers.integration_version = () => ({ data: null, error: null });
  handlers.schema_source = () => ({ data: null, error: null });
  handlers.partner_onboarding_steps = (c) => {
    if (c.op === 'upsert') { w.priorStep = c.args[0].status; return { data: null, error: null }; }
    if (c.terminal === 'maybeSingle') return { data: w.priorStep ? { status: w.priorStep } : null, error: null };
    return { data: w.priorStep ? [{ step_key: 'mapping', status: w.priorStep, detail: {} }] : [], error: null };
  };
  handlers.partner_terms_acceptances = () => ({ data: [], error: null });
  return w;
}

const stepUpserts = () => calls.filter((c) => c.table === 'partner_onboarding_steps' && c.op === 'upsert');
const post = (body: any, auth = 'Bearer owner-1') => request(app()).post(BASE).set('Authorization', auth).send(body);

beforeEach(() => {
  jest.clearAllMocks();
  handlers = {};
  calls = [];
});

describe('mappingStepStatus', () => {
  it('none → null, any certified or live → done, otherwise in_progress', () => {
    expect(mappingStepStatus([])).toBeNull();
    expect(mappingStepStatus(['authorization_required', 'mapping'])).toBe('in_progress');
    expect(mappingStepStatus(['failed', 'certified'])).toBe('done');
    expect(mappingStepStatus(['active'])).toBe('done');
    expect(mappingStepStatus(['degraded'])).toBe('done');
    expect(mappingStepStatus(['suspended', 'revoked'])).toBe('in_progress');
  });
});

describe('access', () => {
  it('401 JSON without a token', async () => {
    const r = await request(app()).get(BASE);
    expect(r.status).toBe(401);
    expect(r.type).toBe('application/json');
  });

  it('is org_admin only', async () => {
    wire({ admin: false });
    const r = await post({ connector_id: 'shopify', provider_id: 'shopify_storefront' }, 'Bearer other-1');
    expect(r.status).toBe(403);
    expect(calls.some((c) => c.table === 'integration_manifest')).toBe(false);
  });

  it('409 CONNECTIONS_LOCKED for a suspended org, before any write', async () => {
    const w = wire();
    w.org.lifecycle_state = 'suspended';
    const r = await post({ connector_id: 'shopify', provider_id: 'shopify_storefront' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('CONNECTIONS_LOCKED');
    expect(calls.some((c) => c.op === 'insert')).toBe(false);
  });
});

describe('POST /:orgId/connections', () => {
  it('400 CONNECTOR_REQUIRED without a connector and without a detection', async () => {
    wire();
    const r = await post({});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('CONNECTOR_REQUIRED');
    expect(calls.some((c) => c.op === 'insert')).toBe(false);
  });

  it('rejects an invalid token and a non-object OpenAPI document', async () => {
    wire();
    expect((await post({ connector_id: 'Shop ify', provider_id: 'x' })).status).toBe(400);
    expect((await post({ connector_id: 'shopify', provider_id: 'shopify_storefront', openapi_document: [1] })).status).toBe(400);
  });

  it("creates the org's partner_tenant owned by the org owner and a connection in the portal state machine", async () => {
    const w = wire();
    const r = await post({ connector_id: 'shopify', provider_id: 'shopify_storefront' });
    expect(r.status).toBe(201);
    expect(w.partnerTenant).toMatchObject({
      name: 'Acme',
      jurisdiction: 'DE',
      partner_organization_id: 'org-1',
      owner_user_id: 'owner-1',
      owner_email: 'ann@acme.example',
      tenant_id: 'maxina',
      status: 'discovered',
    });
    expect(w.manifests[0]).toMatchObject({
      partner_tenant_id: w.partnerTenant!.id,
      connector_id: 'shopify',
      provider_id: 'shopify_storefront',
      connection_type: 'api',
      risk_level: 'medium',
      status: 'authorization_required',
    });
    expect(r.body.connection).toMatchObject({ connector_id: 'shopify', state: 'authorization_required' });

    const types = emitOasisEventMock.mock.calls.map((c) => c[0].type);
    expect(types).toEqual(['partner_org.connection_started', 'partner_org.mapping_step_changed']);
    expect(stepUpserts()[0].args[0]).toMatchObject({ step_key: 'mapping', status: 'in_progress' });
  });

  it('another org admin starting it records no owner email (the owner is still the org owner)', async () => {
    const w = wire();
    await post({ connector_id: 'shopify', provider_id: 'shopify_storefront' }, 'Bearer admin-2');
    expect(w.partnerTenant).toMatchObject({ owner_user_id: 'owner-1', owner_email: null });
  });

  it("defaults the connector from the org's website detection and reuses the org's partner_tenant", async () => {
    const w = wire({
      businessDetails: { platform_detection: { connector_id: 'woocommerce', provider_id: 'woocommerce_rest' } },
      partnerTenant: { id: 'pt-1', name: 'Acme' },
      priorStep: 'in_progress',
    });
    const r = await post({});
    expect(r.status).toBe(201);
    expect(calls.some((c) => c.table === 'partner_tenant' && c.op === 'insert')).toBe(false);
    expect(w.manifests[0]).toMatchObject({ partner_tenant_id: 'pt-1', connector_id: 'woocommerce', provider_id: 'woocommerce_rest' });
    // Step unchanged → no step event, no upsert.
    expect(stepUpserts()).toHaveLength(0);
    expect(emitOasisEventMock.mock.calls.map((c) => c[0].type)).toEqual(['partner_org.connection_started']);
  });

  it('an OpenAPI document starts the connection in mapping', async () => {
    const w = wire();
    const doc = { components: { schemas: { Product: { type: 'object', properties: { sku: { type: 'string' } } } } } };
    const r = await post({ connector_id: 'custom_api', provider_id: 'acme_rest', openapi_document: doc });
    expect(r.status).toBe(201);
    expect(w.manifests[0].status).toBe('mapping');
    expect(calls.some((c) => c.table === 'integration_version' && c.op === 'insert')).toBe(true);
  });
});

describe('GET /:orgId/connections', () => {
  it('lists the org connections, scoped by partner_organization_id', async () => {
    wire({ manifests: [{ id: 'c-1', connector_id: 'shopify', provider_id: 'shopify_storefront', status: 'mapping', partner_tenant: { name: 'Acme' } }] });
    const r = await request(app()).get(BASE).set('Authorization', 'Bearer owner-1');
    expect(r.status).toBe(200);
    expect(r.body.connections[0]).toMatchObject({ id: 'c-1', name: 'Acme', state: 'mapping' });
    const list = calls.find((c) => c.table === 'integration_manifest')!;
    expect(list.filters).toContainEqual(['partner_tenant.partner_organization_id', 'org-1']);
  });

  it('completes the mapping step once a connection is certified, and only once', async () => {
    const w = wire({ manifests: [{ id: 'c-1', status: 'certified', partner_tenant: {} }], priorStep: 'in_progress' });
    const r1 = await request(app()).get(BASE).set('Authorization', 'Bearer owner-1');
    expect(r1.body.mapping_step).toBe('done');
    expect(stepUpserts()).toHaveLength(1);
    expect(emitOasisEventMock.mock.calls[0][0]).toMatchObject({
      type: 'partner_org.mapping_step_changed',
      payload: { from: 'in_progress', to: 'done', connection_count: 1 },
    });
    expect(w.priorStep).toBe('done');

    await request(app()).get(BASE).set('Authorization', 'Bearer owner-1');
    expect(stepUpserts()).toHaveLength(1);
    expect(emitOasisEventMock).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when the org has no connections', async () => {
    wire();
    const r = await request(app()).get(BASE).set('Authorization', 'Bearer owner-1');
    expect(r.body).toEqual({ ok: true, connections: [], mapping_step: null });
    expect(stepUpserts()).toHaveLength(0);
  });
});

describe('per-connection routes, org-scoped (VTID-04527)', () => {
  const CONN = { id: 'c-1', connector_id: 'shopify', provider_id: 'shopify_storefront', connection_type: 'api', risk_level: 'medium', status: 'certified', partner_tenant: { name: 'Acme', owner_user_id: 'owner-1' } };

  it('any org admin (not only the owner) reads a connection of the org', async () => {
    wire({ manifests: [{ ...CONN }] });
    const r = await request(app()).get(`${BASE}/c-1`).set('Authorization', 'Bearer admin-2');
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ id: 'c-1', name: 'Acme', state: 'certified' });
    const q = calls.find((c) => c.table === 'integration_manifest' && c.terminal === 'maybeSingle')!;
    expect(q.filters).toContainEqual(['id', 'c-1']);
    expect(q.filters).toContainEqual(['partner_tenant.partner_organization_id', 'org-1']);
  });

  it("another org's connection id is a 404", async () => {
    wire({ manifests: [{ ...CONN, id: 'c-9', org: 'org-2' }] });
    const r = await request(app()).get(`${BASE}/c-9`).set('Authorization', 'Bearer owner-1');
    expect(r.status).toBe(404);
  });

  it('a non-admin is refused before any connection is read', async () => {
    wire({ manifests: [{ ...CONN }], admin: false });
    const r = await request(app()).post(`${BASE}/c-1/revoke`).set('Authorization', 'Bearer other-1');
    expect(r.status).toBe(403);
    expect(calls.some((c) => c.table === 'integration_manifest')).toBe(false);
  });

  it('revoke moves the connection, records the onboarding surface, and reconciles the mapping step', async () => {
    const w = wire({ manifests: [{ ...CONN }], priorStep: 'done' });
    const r = await request(app()).post(`${BASE}/c-1/revoke`).set('Authorization', 'Bearer admin-2');
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ id: 'c-1', state: 'revoked' });
    expect(w.manifests[0].status).toBe('revoked');

    const audit = calls.find((c) => c.table === 'oasis_events' && c.op === 'insert')!;
    expect(audit.args[0]).toMatchObject({ type: 'vcaop.portal.connection.revoked', metadata: { surface: 'partner_onboarding', actor: 'admin-2' } });

    expect(stepUpserts()[0].args[0]).toMatchObject({ step_key: 'mapping', status: 'in_progress' });
    expect(emitOasisEventMock.mock.calls[0][0]).toMatchObject({
      type: 'partner_org.mapping_step_changed',
      payload: { from: 'done', to: 'in_progress', connection_count: 1 },
    });
  });

  it('an illegal transition is a 409 and changes nothing', async () => {
    const w = wire({ manifests: [{ ...CONN, status: 'revoked' }] });
    const r = await request(app()).post(`${BASE}/c-1/resume`).set('Authorization', 'Bearer owner-1');
    expect(r.status).toBe(409);
    expect(w.manifests[0].status).toBe('revoked');
    expect(stepUpserts()).toHaveLength(0);
  });

  it('there is no activation route on this surface', async () => {
    wire({ manifests: [{ ...CONN }] });
    const r = await request(app()).post(`${BASE}/c-1/approve-activation`).set('Authorization', 'Bearer owner-1');
    expect(r.status).toBe(404);
  });

  it('guards run per route, so an unrelated path under an org stays a plain 404', async () => {
    wire();
    const r = await request(app()).get('/api/v1/partner-onboarding/org-1/nothing-here');
    expect(r.status).toBe(404);
  });
});
