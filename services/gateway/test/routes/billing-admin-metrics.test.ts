/**
 * routes/billing.ts — GET /admin/metrics — log-only swallowed-Supabase-error
 * fix (BOOTSTRAP-AURORA-CUTOVER).
 *
 * Five reads feeding the admin revenue dashboard (fetchActiveOrTrialingSubscriptions,
 * fetchActiveMonthlyPlanPrices, fetchPaywallFunnelSince, fetchRedemptionsSince,
 * fetchVoiceDegradeEventsSince) previously discarded `error`, so a real DB
 * failure on any of them silently rendered that section of the dashboard as
 * zero rather than surfacing anywhere. This is display-only (not enforcement),
 * so the fix is log-only: the response shape/values are unchanged, but every
 * failure is now logged loudly.
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

const mockFetchActiveOrTrialingSubscriptions = jest.fn();
const mockFetchActiveMonthlyPlanPrices = jest.fn();
const mockFetchPaywallFunnelSince = jest.fn();
const mockFetchRedemptionsSince = jest.fn();
const mockFetchVoiceDegradeEventsSince = jest.fn();
const mockFetchTenantSettingsFeatureFlags = jest.fn();
jest.mock('../../src/routes/billing-repository', () => ({
  ...jest.requireActual('../../src/routes/billing-repository'),
  fetchActiveOrTrialingSubscriptions: (...args: unknown[]) => mockFetchActiveOrTrialingSubscriptions(...args),
  fetchActiveMonthlyPlanPrices: (...args: unknown[]) => mockFetchActiveMonthlyPlanPrices(...args),
  fetchPaywallFunnelSince: (...args: unknown[]) => mockFetchPaywallFunnelSince(...args),
  fetchRedemptionsSince: (...args: unknown[]) => mockFetchRedemptionsSince(...args),
  fetchVoiceDegradeEventsSince: (...args: unknown[]) => mockFetchVoiceDegradeEventsSince(...args),
  fetchTenantSettingsFeatureFlags: (...args: unknown[]) => mockFetchTenantSettingsFeatureFlags(...args),
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

describe('GET /admin/metrics — swallowed-error visibility', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockFetchActiveOrTrialingSubscriptions.mockResolvedValue({ data: [], error: null });
    mockFetchActiveMonthlyPlanPrices.mockResolvedValue({ data: [], error: null });
    mockFetchPaywallFunnelSince.mockResolvedValue({ data: [], error: null });
    mockFetchRedemptionsSince.mockResolvedValue({ data: [], error: null });
    mockFetchVoiceDegradeEventsSince.mockResolvedValue({ data: [], error: null });
    mockFetchTenantSettingsFeatureFlags.mockResolvedValue({ data: null, error: null });
  });

  afterEach(() => errorSpy.mockRestore());

  it('all five queries succeeding: 200, no error logs, zeroed sections as normal', async () => {
    const res = await request(buildApp()).get('/api/v1/billing/admin/metrics');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.revenue.mrr_cents).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['fetchActiveOrTrialingSubscriptions', () => mockFetchActiveOrTrialingSubscriptions],
    ['fetchActiveMonthlyPlanPrices', () => mockFetchActiveMonthlyPlanPrices],
    ['fetchPaywallFunnelSince', () => mockFetchPaywallFunnelSince],
    ['fetchRedemptionsSince', () => mockFetchRedemptionsSince],
    ['fetchVoiceDegradeEventsSince', () => mockFetchVoiceDegradeEventsSince],
  ])('a real DB error from %s is logged loudly, but the dashboard still responds 200 with the section zeroed (unchanged shape)', async (name, getMock) => {
    getMock().mockResolvedValue({ data: null, error: { message: `${name} boom` } });

    const res = await request(buildApp()).get('/api/v1/billing/admin/metrics');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(name));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(`${name} boom`));
  });
});
