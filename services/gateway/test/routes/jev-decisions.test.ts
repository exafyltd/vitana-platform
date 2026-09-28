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
jest.mock('../../src/middleware/require-tenant-admin-repository', () => ({
  fetchCallerActiveRoleForTenant: jest.fn(async (_sb: unknown, userId: string) => ({ data: roles[userId] ? { active_role: roles[userId] } : null, error: null })),
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
});
