/**
 * routes/billing.ts — GET /me wallet error-visibility fix.
 *
 * wallet_balances does not exist in live Supabase (confirmed via
 * AURORA-B2-DEAD-CALLSITE-AUDIT.md's addendum). supabase-js resolves
 * normally with an {error} field on a "relation does not exist" failure
 * rather than throwing, so this route — the single endpoint powering the
 * Subscriptions screen — previously silently rendered every user's wallet
 * as all-zero with no trace anywhere. Pins that the failure is now logged,
 * while the response contract (ok:true, all-zero fallback) is unchanged.
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

const mockFetchWalletBalances = jest.fn();
jest.mock('../../src/routes/billing-repository', () => ({
  ...jest.requireActual('../../src/routes/billing-repository'),
  fetchUserSubscription: jest.fn(async () => ({ data: null, error: null })),
  fetchFeatureEntitlements: jest.fn(async () => ({ data: [], error: null })),
  fetchYearEarningTransactions: jest.fn(async () => ({ data: [], error: null })),
  fetchWalletBalances: (...args: unknown[]) => mockFetchWalletBalances(...args),
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

describe('GET /me — wallet snapshot', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('on the RPC returning {error} (the wallet_balances-does-not-exist shape): logs it loudly, and still renders an all-zero wallet (unchanged contract)', async () => {
    mockFetchWalletBalances.mockResolvedValue({
      data: null,
      error: { message: 'relation "wallet_balances" does not exist' },
    });

    const res = await request(buildApp()).get('/api/v1/billing/me');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.wallet).toEqual({
      purchased_credits: 0, reward_credits: 0, cash_balance: 0, balance_total: 0,
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('fetchWalletBalances error (wallet will render as all-zero)'),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('relation "wallet_balances" does not exist'));
  });

  it('on a successful fetch: logs nothing and renders the real wallet', async () => {
    mockFetchWalletBalances.mockResolvedValue({
      data: { purchased_credits: 10, reward_credits: 5, cash_balance: 2, balance: 17 },
      error: null,
    });

    const res = await request(buildApp()).get('/api/v1/billing/me');

    expect(res.status).toBe(200);
    expect(res.body.wallet).toEqual({
      purchased_credits: 10, reward_credits: 5, cash_balance: 2, balance_total: 17,
    });
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('fetchWalletBalances error'));
  });
});
