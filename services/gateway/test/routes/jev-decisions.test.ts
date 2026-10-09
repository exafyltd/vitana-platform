/**
 * VTID-04473: /api/v1/jev/* routes. Auth is stubbed from test headers; the
 * active_role lookup is a fake; the Jev HTTP call is intercepted via global
 * fetch. Nothing leaves the process.
 */
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: () => void) => {
    const uid = req.headers['x-test-user'];
    if (!uid) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    req.identity = { user_id: uid, tenant_id: 't1', exafy_admin: req.headers['x-test-admin'] === '1', email: null, role: null, aud: null, exp: null, iat: null };
    next();
  },
  requireExafyAdmin: (req: any, res: any, next: () => void) =>
    req.identity?.exafy_admin ? next() : res.status(403).json({ ok: false, error: 'FORBIDDEN' }),
}));

const roles: Record<string, string> = {};
jest.mock('../../src/lib/supabase', () => ({ getSupabase: () => ({}) }));
// VTID-04754: role, tenant flag and spend reads all go through jev-repository.
const ok = (data: unknown) => ({ data, error: null });
jest.mock('../../src/services/jev/jev-repository', () => ({
  fetchPrimaryTenant: jest.fn(async () => ok({ tenant_id: 't1' })),
  fetchLatestRolePreference: jest.fn(async () => ok(null)),
  fetchTenantActiveRole: jest.fn(async (_sb: unknown, userId: string) => ok(roles[userId] ? { active_role: roles[userId] } : null)),
  fetchExplicitRoleGrants: jest.fn(async (_sb: unknown, userId: string) => ok(roles[userId] ? [{ role: roles[userId] }] : [])),
  fetchActiveMembershipRoles: jest.fn(async () => ok([])),
  fetchTenantByIdOrSlug: jest.fn(async (_sb: unknown, v: string) => ok(v === 'maxina' || v === 't1' ? { tenant_id: 't1', slug: 'maxina' } : null)),
  fetchTenantFeatureFlags: jest.fn(async () => ok(null)),
  fetchTenantMonthSpend: jest.fn(async () => ok([])),
  recordSpendRpc: jest.fn(async () => ok(0)),
  fetchMonthSpendRows: jest.fn(async () => ok([{ tenant_id: 't1', plane: 'internal', calls: 3, input_tokens: 2400, cost_usd: 0.0001 }])),
  shadowGateStatsRpc: jest.fn(async () => ok([])),
  fetchDevAutopilotKillSwitch: jest.fn(async () => ok({ kill_switch: true, updated_at: '2026-10-07T08:08:58Z' })),
  insertShadowDecision: jest.fn(async () => ok({ id: 's1' })),
  updateShadowOutcome: jest.fn(async () => ok(null)),
}));
jest.mock('../../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));

import express from 'express';
import request from 'supertest';
import router from '../../src/routes/jev-decisions';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1', router);
  return a;
}

const realFetch = global.fetch;
let jevFetch: jest.Mock;

beforeEach(() => {
  Object.assign(roles, { backoffice1: 'backoffice', member1: 'community', dev1: 'developer' });
  process.env.JEV_DECISIONS_ENABLED = 'true';
  process.env.TYPESAFE_API_KEY = 'test-key';
  delete process.env.JEV_COMMUNITY_ENABLED;
  jevFetch = jest.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const text = String(body.state?.document?.text ?? '');
    const rel = text.includes('invoice');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: 'jev-1.13.0',
        answers: {
          relevant: { type: 'noul', noul: rel ? 0.97 : 0.03 },
          strength: { type: 'score', score: rel ? 3 : 0, probabilities: rel ? [0, 0, 0.1, 0.9] : [0.9, 0.1, 0, 0], confidence: 0.9 },
        },
        usage: { input_tokens: 800, output_tokens: 2 },
      }),
    };
  });
  (global as any).fetch = jevFetch;
});

afterAll(() => {
  (global as any).fetch = realFetch;
  delete process.env.JEV_DECISIONS_ENABLED;
  delete process.env.TYPESAFE_API_KEY;
});

describe('VTID-04473 jev routes', () => {
  test('unauthenticated → 401', async () => {
    expect((await request(app()).get('/api/v1/jev/decisions')).status).toBe(401);
  });

  test('GET /jev/decisions lists only what the role may use', async () => {
    const res = await request(app()).get('/api/v1/jev/decisions').set('x-test-user', 'backoffice1');
    expect(res.status).toBe(200);
    expect(res.body.data.access).toEqual({ allowed: true, plane: 'internal', role: 'backoffice' });
    const names = res.body.data.decisions.map((d: any) => d.name);
    expect(names).toContain('document_relevance');
    expect(names).not.toContain('ci_failure_bucket');
  });

  test('a community member sees no decisions and is refused on use', async () => {
    const list = await request(app()).get('/api/v1/jev/decisions').set('x-test-user', 'member1');
    expect(list.body.data.access).toEqual({ allowed: false, reason: 'community_not_enabled' });
    expect(list.body.data.decisions).toEqual([]);
    const use = await request(app()).post('/api/v1/jev/decisions/support_ticket_triage').set('x-test-user', 'member1').send({ input: { body: 'x' } });
    expect(use.status).toBe(403);
    expect(use.body.error).toBe('community_not_enabled');
    expect(jevFetch).not.toHaveBeenCalled();
  });

  test('a role in the request body is ignored — the role comes from user_tenants', async () => {
    const res = await request(app())
      .post('/api/v1/jev/decisions/support_ticket_triage')
      .set('x-test-user', 'member1')
      .send({ input: { body: 'x' }, role: 'admin', active_role: 'admin' });
    expect(res.status).toBe(403);
  });

  test('POST /jev/documents/classify returns the relevant documents ranked, with cost', async () => {
    const documents = [
      { id: 'd1', text: 'Team lunch photos' },
      { id: 'd2', title: 'Q3', text: 'Supplier invoice 2026-07, amount due' },
      { id: 'd3', text: 'Holiday plan' },
      { id: 'd4', text: 'Invoice reminder from the landlord, invoice attached' },
    ];
    const res = await request(app()).post('/api/v1/jev/documents/classify').set('x-test-user', 'backoffice1').send({ query: 'unpaid invoices', documents });
    expect(res.status).toBe(200);
    expect(res.body.data.counts).toEqual({ documents: 4, relevant: 2, abstained: 0, failed: 0 });
    expect(res.body.data.relevant.map((r: any) => r.id).sort()).toEqual(['d2', 'd4']);
    expect(res.body.data.input_tokens).toBe(3200);
    expect(res.body.data.cost_usd).toBeCloseTo(3200 * 0.042 / 1e6, 10);
    expect(jevFetch).toHaveBeenCalledTimes(4);
  });

  test('classify: not configured answers once with 503, no per-document calls', async () => {
    delete process.env.TYPESAFE_API_KEY;
    const res = await request(app()).post('/api/v1/jev/documents/classify').set('x-test-user', 'backoffice1').send({ query: 'q', documents: [{ id: 'a', text: 'b' }] });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('not_configured');
    expect(jevFetch).not.toHaveBeenCalled();
  });

  test('classify: batch over 500 → 400', async () => {
    const documents = Array.from({ length: 501 }, (_, i) => ({ id: String(i), text: 't' }));
    const res = await request(app()).post('/api/v1/jev/documents/classify').set('x-test-user', 'backoffice1').send({ query: 'q', documents });
    expect(res.status).toBe(400);
  });

  test('GET /jev/admin/stats is exafy_admin only', async () => {
    expect((await request(app()).get('/api/v1/jev/admin/stats').set('x-test-user', 'dev1')).status).toBe(403);
    const ok = await request(app()).get('/api/v1/jev/admin/stats').set('x-test-user', 'root').set('x-test-admin', '1');
    expect(ok.status).toBe(200);
    expect(ok.body.data).toHaveProperty('by_plane');
    expect(ok.body.data.community_enabled).toBe(false);
  });

  // VTID-04754
  test('GET /jev/decisions shows planes, data class and the resolved tenant', async () => {
    const res = await request(app()).get('/api/v1/jev/decisions').set('x-test-user', 'backoffice1');
    expect(res.body.data.tenant_id).toBe('t1');
    const doc = res.body.data.decisions.find((d: any) => d.name === 'document_relevance');
    expect(doc).toMatchObject({ planes: ['internal'], data: 'business' });
  });

  test('an acting role the user does not hold is refused', async () => {
    const res = await request(app())
      .post('/api/v1/jev/decisions/support_ticket_triage')
      .set('x-test-user', 'backoffice1')
      .set('x-jev-acting-role', 'developer')
      .send({ input: { body: 'x' } });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('acting_role_not_permitted');
    expect(jevFetch).not.toHaveBeenCalled();
  });

  test('exafy_admin: tenant data needs a named tenant; an unknown one is 404', async () => {
    const none = await request(app()).post('/api/v1/jev/decisions/support_ticket_triage').set('x-test-user', 'root').set('x-test-admin', '1').send({ input: { body: 'x' } });
    expect(none.status).toBe(400);
    expect(none.body.error).toBe('target_tenant_required');
    const unknown = await request(app()).post('/api/v1/jev/decisions/support_ticket_triage').set('x-test-user', 'root').set('x-test-admin', '1').set('x-jev-tenant', 'nope').send({ input: { body: 'x' } });
    expect(unknown.status).toBe(404);
    expect(jevFetch).not.toHaveBeenCalled();
  });

  test('GET /jev/admin/stats carries the persisted month spend and the shadow gates', async () => {
    const res = await request(app()).get('/api/v1/jev/admin/stats').set('x-test-user', 'root').set('x-test-admin', '1');
    expect(res.status).toBe(200);
    expect(res.body.data.month).toMatch(/^\d{4}-\d{2}-01$/);
    expect(res.body.data.spend_month).toEqual([{ tenant_id: 't1', plane: 'internal', calls: 3, input_tokens: 2400, cost_usd: 0.0001 }]);
    expect(res.body.data.shadow_gates).toEqual([]);
    expect(res.body.data).toHaveProperty('gate_modes');
    // VTID-05012: the loop next to its gates.
    expect(res.body.data.loops).toEqual({ dev_autopilot: { kill_switch: true, updated_at: '2026-10-07T08:08:58Z' } });
    expect(Array.isArray(res.body.data.gate_health)).toBe(true);
  });
});
