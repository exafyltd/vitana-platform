/**
 * routes/billing.ts — POST /admin/redemption-codes/generate —
 * fetchPlanByKey error-visibility fix (BOOTSTRAP-AURORA-CUTOVER).
 *
 * fetchPlanByKey()'s `error` was previously discarded, so a real DB failure
 * on the plan-existence check masqueraded as `400 PLAN_NOT_FOUND`, identical
 * to an admin genuinely typing a bad plan key. Now a real DB error surfaces
 * as `500 PLAN_LOOKUP_FAILED`.
 */

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => ({})),
}));

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  ...jest.requireActual('../../src/middleware/auth-supabase-jwt'),
  requireAuth: (req: any, _res: any, next: () => void) => {
    req.identity = { user_id: 'admin-1', tenant_id: 't1', exafy_admin: true };
    next();
  },
  requireExafyAdmin: (_req: any, _res: any, next: () => void) => next(),
}));

const mockFetchPlanByKey = jest.fn();
const mockInsertRedemptionCodes = jest.fn();
jest.mock('../../src/routes/billing-repository', () => ({
  ...jest.requireActual('../../src/routes/billing-repository'),
  fetchPlanByKey: (...args: unknown[]) => mockFetchPlanByKey(...args),
  insertRedemptionCodes: (...args: unknown[]) => mockInsertRedemptionCodes(...args),
}));

import express from 'express';
import request from 'supertest';
import billingRouter from '../../src/routes/billing';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/billing', billingRouter);
  return app;
}

describe('POST /admin/redemption-codes/generate — fetchPlanByKey error handling', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockInsertRedemptionCodes.mockResolvedValue({ error: null });
  });

  afterEach(() => errorSpy.mockRestore());

  it('a real DB error responds 500 PLAN_LOOKUP_FAILED (not the misleading 400 PLAN_NOT_FOUND)', async () => {
    mockFetchPlanByKey.mockResolvedValue({ data: null, error: { message: 'connection terminated unexpectedly' } });

    const res = await request(buildApp())
      .post('/api/v1/billing/admin/redemption-codes/generate')
      .send({ campaign: 'launch2026', count: 5, grants_plan: 'premium' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'PLAN_LOOKUP_FAILED', message: 'connection terminated unexpectedly' });
    expect(mockInsertRedemptionCodes).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('fetchPlanByKey error'));
  });

  it('a genuinely nonexistent plan (no error) still 400s PLAN_NOT_FOUND — unchanged', async () => {
    mockFetchPlanByKey.mockResolvedValue({ data: null, error: null });

    const res = await request(buildApp())
      .post('/api/v1/billing/admin/redemption-codes/generate')
      .send({ campaign: 'launch2026', count: 5, grants_plan: 'nonexistent' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'PLAN_NOT_FOUND', plan_key: 'nonexistent' });
  });

  it('a real plan still generates codes — unchanged', async () => {
    mockFetchPlanByKey.mockResolvedValue({ data: { plan_key: 'premium' }, error: null });

    const res = await request(buildApp())
      .post('/api/v1/billing/admin/redemption-codes/generate')
      .send({ campaign: 'launch2026', count: 3, grants_plan: 'premium' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.generated).toBe(3);
    expect(mockInsertRedemptionCodes).toHaveBeenCalledTimes(1);
  });
});
