/**
 * VTID-04868 — /api/v1/plans/spar routes: auth gates, status mapping, and
 * that the approver is the VERIFIED identity, never a body field.
 *
 * The service layer is mocked; its behaviour is covered in
 * vtid-04868-plan-sparring-service.test.ts.
 */

process.env.NODE_ENV = 'test';
process.env.GATEWAY_SERVICE_TOKEN = 'svc-token';

const ADMIN_ID = '11111111-2222-4333-8444-555555555555';

// JWT layer: "admin-jwt" → exafy_admin, "member-jwt" → plain member.
jest.mock('../src/middleware/auth-supabase-jwt', () => {
  const identityFor = (h?: string) => {
    if (h === 'Bearer admin-jwt') return { user_id: ADMIN_ID, email: 'owner@example.com', exafy_admin: true };
    if (h === 'Bearer member-jwt') return { user_id: '99999999-2222-4333-8444-555555555555', email: 'm@example.com', exafy_admin: false };
    return undefined;
  };
  return {
    optionalAuth: (req: any, _res: any, next: () => void) => {
      const id = identityFor(req.header('authorization'));
      if (id) req.identity = id;
      next();
    },
    requireAdminAuth: (req: any, res: any, next: () => void) => {
      const id = identityFor(req.header('authorization'));
      if (!id) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
      req.identity = id;
      if (!id.exafy_admin) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
      next();
    },
  };
});

const svc = {
  createSparringSession: jest.fn(),
  submitPlannerRound: jest.fn(),
  getSparringSession: jest.fn(),
  approveSparringSession: jest.fn(),
};
jest.mock('../src/services/plan-sparring/plan-sparring-service', () => {
  const actual = jest.requireActual('../src/services/plan-sparring/plan-sparring-service');
  return {
    SparringError: actual.SparringError,
    defaultDeps: () => ({}),
    createSparringSession: (...a: unknown[]) => svc.createSparringSession(...a),
    submitPlannerRound: (...a: unknown[]) => svc.submitPlannerRound(...a),
    getSparringSession: (...a: unknown[]) => svc.getSparringSession(...a),
    approveSparringSession: (...a: unknown[]) => svc.approveSparringSession(...a),
  };
});

import express from 'express';
import request from 'supertest';
import { createPlansSparRouter } from '../src/routes/plans-spar';
import { SparringError } from '../src/services/plan-sparring/plan-sparring-service';

const ID = '00000000-0000-4000-8000-000000000001';
const deps = { marker: 'deps' };

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/plans/spar', createPlansSparRouter(() => deps as never));
  return a;
}

beforeEach(() => jest.clearAllMocks());

describe('auth', () => {
  it.each([
    ['post', '/api/v1/plans/spar'],
    ['post', `/api/v1/plans/spar/${ID}/rounds`],
    ['get', `/api/v1/plans/spar/${ID}`],
    ['post', `/api/v1/plans/spar/${ID}/approve`],
  ])('%s %s without a token is 401', async (method, path) => {
    const res = await (request(app()) as any)[method](path).send({});
    expect(res.status).toBe(401);
  });

  it('a non-admin JWT cannot create, read or approve', async () => {
    for (const r of [
      request(app()).post('/api/v1/plans/spar').set('Authorization', 'Bearer member-jwt').send({}),
      request(app()).get(`/api/v1/plans/spar/${ID}`).set('Authorization', 'Bearer member-jwt'),
      request(app()).post(`/api/v1/plans/spar/${ID}/approve`).set('Authorization', 'Bearer member-jwt').send({}),
    ]) {
      expect((await r).status).toBe(403);
    }
    expect(svc.createSparringSession).not.toHaveBeenCalled();
    expect(svc.approveSparringSession).not.toHaveBeenCalled();
  });

  it('the service token may create/round/read but NOT approve', async () => {
    svc.createSparringSession.mockResolvedValue({ session: { id: ID }, deduplicated: false });
    svc.getSparringSession.mockResolvedValue({ id: ID });
    expect((await request(app()).post('/api/v1/plans/spar').set('Authorization', 'Bearer svc-token').send({ a: 1 })).status).toBe(201);
    expect((await request(app()).get(`/api/v1/plans/spar/${ID}`).set('Authorization', 'Bearer svc-token')).status).toBe(200);
    const approve = await request(app()).post(`/api/v1/plans/spar/${ID}/approve`).set('Authorization', 'Bearer svc-token').send({});
    expect(approve.status).toBe(401);
    expect(svc.approveSparringSession).not.toHaveBeenCalled();
  });
});

describe('handlers', () => {
  it('POST / → 201 new, 200 deduplicated; body and deps passed through', async () => {
    svc.createSparringSession.mockResolvedValueOnce({ session: { id: ID }, deduplicated: false });
    const r1 = await request(app()).post('/api/v1/plans/spar').set('Authorization', 'Bearer admin-jwt').send({ plan_text: 'p' });
    expect(r1.status).toBe(201);
    expect(r1.body).toEqual({ ok: true, deduplicated: false, session: { id: ID } });
    expect(svc.createSparringSession).toHaveBeenCalledWith({ plan_text: 'p' }, deps);

    svc.createSparringSession.mockResolvedValueOnce({ session: { id: ID }, deduplicated: true });
    const r2 = await request(app()).post('/api/v1/plans/spar').set('Authorization', 'Bearer admin-jwt').send({ plan_text: 'p' });
    expect(r2.status).toBe(200);
  });

  it('POST /:id/rounds passes id + body', async () => {
    svc.submitPlannerRound.mockResolvedValue({ id: ID, verdict: 'converged' });
    const r = await request(app()).post(`/api/v1/plans/spar/${ID}/rounds`).set('Authorization', 'Bearer svc-token').send({ responses: [] });
    expect(r.status).toBe(200);
    expect(svc.submitPlannerRound).toHaveBeenCalledWith(ID, { responses: [] }, deps);
  });

  it('approve uses the verified identity, ignoring any actor in the body', async () => {
    svc.approveSparringSession.mockResolvedValue({ id: ID, human_approved_by: ADMIN_ID });
    const r = await request(app())
      .post(`/api/v1/plans/spar/${ID}/approve`)
      .set('Authorization', 'Bearer admin-jwt')
      .send({ final_plan_hash: 'h', human_approved_by: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    expect(r.status).toBe(200);
    expect(svc.approveSparringSession).toHaveBeenCalledWith(
      ID,
      { user_id: ADMIN_ID, email: 'owner@example.com' },
      { final_plan_hash: 'h', human_approved_by: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      deps,
    );
  });

  it('maps SparringError to its status; unknown errors to 500 without leaking', async () => {
    svc.getSparringSession.mockRejectedValueOnce(new SparringError(404, 'not_found'));
    const r1 = await request(app()).get(`/api/v1/plans/spar/${ID}`).set('Authorization', 'Bearer admin-jwt');
    expect(r1.status).toBe(404);
    expect(r1.body).toEqual({ ok: false, error: 'not_found' });

    svc.submitPlannerRound.mockRejectedValueOnce(new SparringError(409, 'session_converged'));
    expect((await request(app()).post(`/api/v1/plans/spar/${ID}/rounds`).set('Authorization', 'Bearer admin-jwt').send({})).status).toBe(409);

    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    svc.createSparringSession.mockRejectedValueOnce(new Error('secret db detail'));
    const r3 = await request(app()).post('/api/v1/plans/spar').set('Authorization', 'Bearer admin-jwt').send({});
    expect(r3.status).toBe(500);
    expect(JSON.stringify(r3.body)).not.toContain('secret db detail');
    spy.mockRestore();
  });
});
