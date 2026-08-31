/**
 * routes/automations.ts — GET /wallet/balance error-visibility fix.
 *
 * wallet_balances does not exist in live Supabase (confirmed via
 * AURORA-B2-DEAD-CALLSITE-AUDIT.md's addendum). supabase-js resolves
 * normally with an {error} field on a "relation does not exist" failure
 * rather than throwing, so this route previously silently rendered every
 * user's balance as all-zero with no trace anywhere. This pins that the
 * failure is now logged, while the response contract (ok:true, all-zero
 * fallback) is unchanged — which table/column mapping is canonical is a
 * separate product/eng decision, not fixed here.
 */

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE = 'service-role-key';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({})),
}));

const mockFetchWalletBalance = jest.fn();
jest.mock('../../src/routes/automations-repository', () => ({
  ...jest.requireActual('../../src/routes/automations-repository'),
  fetchWalletBalance: (...args: unknown[]) => mockFetchWalletBalance(...args),
}));

import express from 'express';
import request from 'supertest';
import automationsRouter from '../../src/routes/automations';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.identity = { user_id: 'u1', tenant_id: 't1' };
    next();
  });
  app.use('/api/v1/automations', automationsRouter);
  return app;
}

describe('GET /wallet/balance', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('on the RPC returning {error} (the wallet_balances-does-not-exist shape): logs it loudly, and still returns an all-zero balance (unchanged contract)', async () => {
    mockFetchWalletBalance.mockResolvedValue({
      data: null,
      error: { message: 'relation "wallet_balances" does not exist' },
    });

    const res = await request(buildApp()).get('/api/v1/automations/wallet/balance');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      balance: 0,
      total_earned: 0,
      total_spent: 0,
      updated_at: null,
    });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('fetchWalletBalance error'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('relation "wallet_balances" does not exist'));
  });

  it('on a successful fetch: logs nothing and returns the real balance', async () => {
    mockFetchWalletBalance.mockResolvedValue({
      data: { balance: 42, total_earned: 100, total_spent: 58, updated_at: '2026-08-29T00:00:00Z' },
      error: null,
    });

    const res = await request(buildApp()).get('/api/v1/automations/wallet/balance');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      balance: 42,
      total_earned: 100,
      total_spent: 58,
      updated_at: '2026-08-29T00:00:00Z',
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
