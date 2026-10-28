/**
 * routes/billing.ts — GET /me usage/entitlement reads — log-only
 * swallowed-Supabase-error fix (BOOTSTRAP-AURORA-CUTOVER).
 *
 * fetchFeatureEntitlements + both rpcGetFeatureUsageInWindow call sites +
 * rpcGetFeatureUsage all previously discarded `error`, so a real DB failure
 * rendered as "unlimited/no usage shown" instead of a legitimate zero. These
 * RPCs are display-only for the Subscriptions screen (confirmed not used for
 * enforcement elsewhere), so the fix is log-only: response shape/values are
 * unchanged, every failure is now logged loudly.
 */

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => ({})),
}));

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  ...jest.requireActual('../../src/middleware/auth-supabase-jwt'),
  requireAuth: (req: any, _res: any, next: () => void) => {
    req.identity = { user_id: 'u1', tenant_id: 't1' };
    next();
  },
}));

jest.mock('../../src/services/entitlement-service', () => ({
  ...jest.requireActual('../../src/services/entitlement-service'),
  getUserPlan: jest.fn(async () => ({
    plan_key: 'free', status: 'free', current_period_end: null,
    cancel_at_period_end: false, trial_end: null, metadata: {},
  })),
}));

const mockFetchFeatureEntitlements = jest.fn();
const mockRpcGetFeatureUsageInWindow = jest.fn();
const mockRpcGetFeatureUsage = jest.fn();
jest.mock('../../src/routes/billing-repository', () => ({
  ...jest.requireActual('../../src/routes/billing-repository'),
  fetchUserSubscription: jest.fn(async () => ({ data: null, error: null })),
  fetchWalletBalances: jest.fn(async () => ({ data: null, error: null })),
  fetchYearEarningTransactions: jest.fn(async () => ({ data: [], error: null })),
  fetchFeatureEntitlements: (...args: unknown[]) => mockFetchFeatureEntitlements(...args),
  rpcGetFeatureUsageInWindow: (...args: unknown[]) => mockRpcGetFeatureUsageInWindow(...args),
  rpcGetFeatureUsage: (...args: unknown[]) => mockRpcGetFeatureUsage(...args),
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

const ROW = {
  feature_key: 'orb_minutes', quota: 100, window_seconds: 2592000,
  window_5h_quota: 10, weekly_quota: 40, unit: 'minutes', behavior_on_exceed: 'block',
};

describe('GET /me — usage/entitlement error visibility', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockRpcGetFeatureUsageInWindow.mockResolvedValue({ data: { used: 1, reset_at: null }, error: null });
    mockRpcGetFeatureUsage.mockResolvedValue({ data: { used: 2, window_end: null }, error: null });
  });

  afterEach(() => errorSpy.mockRestore());

  it('fetchFeatureEntitlements error: logged loudly, usage renders empty (unchanged), still 200', async () => {
    mockFetchFeatureEntitlements.mockResolvedValue({ data: null, error: { message: 'entitlements boom' } });

    const res = await request(buildApp()).get('/api/v1/billing/me');

    expect(res.status).toBe(200);
    expect(res.body.usage).toEqual({});
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('fetchFeatureEntitlements error'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('entitlements boom'));
  });

  it('rpcGetFeatureUsageInWindow(5h) error: logged loudly, that window renders used=0 (unchanged)', async () => {
    mockFetchFeatureEntitlements.mockResolvedValue({ data: [ROW], error: null });
    mockRpcGetFeatureUsageInWindow.mockImplementation(async (_sb: unknown, args: { windowSeconds: number }) => {
      if (args.windowSeconds === 5 * 60 * 60) return { data: null, error: { message: '5h window boom' } };
      return { data: { used: 3, reset_at: null }, error: null };
    });

    const res = await request(buildApp()).get('/api/v1/billing/me');

    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('rpcGetFeatureUsageInWindow(5h) error for feature=orb_minutes'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('5h window boom'));
  });

  it('rpcGetFeatureUsageInWindow(weekly) error: logged loudly, that window renders used=0 (unchanged)', async () => {
    mockFetchFeatureEntitlements.mockResolvedValue({ data: [ROW], error: null });
    mockRpcGetFeatureUsageInWindow.mockImplementation(async (_sb: unknown, args: { windowSeconds: number }) => {
      if (args.windowSeconds === 7 * 24 * 60 * 60) return { data: null, error: { message: 'weekly window boom' } };
      return { data: { used: 3, reset_at: null }, error: null };
    });

    const res = await request(buildApp()).get('/api/v1/billing/me');

    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('rpcGetFeatureUsageInWindow(weekly) error for feature=orb_minutes'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('weekly window boom'));
  });

  it('rpcGetFeatureUsage(monthly) error: logged loudly, monthly renders used=0 (unchanged)', async () => {
    mockFetchFeatureEntitlements.mockResolvedValue({ data: [ROW], error: null });
    mockRpcGetFeatureUsage.mockResolvedValue({ data: null, error: { message: 'monthly boom' } });

    const res = await request(buildApp()).get('/api/v1/billing/me');

    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('rpcGetFeatureUsage(monthly) error for feature=orb_minutes'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('monthly boom'));
  });

  it('all succeeding: no error logs, usage populated normally (unchanged)', async () => {
    mockFetchFeatureEntitlements.mockResolvedValue({ data: [ROW], error: null });

    const res = await request(buildApp()).get('/api/v1/billing/me');

    expect(res.status).toBe(200);
    expect(res.body.usage.orb_minutes).toBeDefined();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
