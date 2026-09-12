/**
 * routes/wallet.ts — GET /wallet/deposits/:id error-visibility fix.
 *
 * A real database failure resolving a user's own deposit previously
 * returned 404 NOT_FOUND — indistinguishable from the deposit genuinely
 * not existing — misleading a user polling the status of their own
 * just-paid Stripe deposit. Pins the route now returns a distinct
 * 500 LOOKUP_FAILED when getDepositForUser() reports a real query error.
 */

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  ...jest.requireActual('../../src/middleware/auth-supabase-jwt'),
  requireAuth: (req: any, _res: any, next: () => void) => {
    req.identity = { user_id: 'u1', tenant_id: 't1' };
    next();
  },
}));

const mockGetDepositForUser = jest.fn();
const mockCreateDeposit = jest.fn();
jest.mock('../../src/services/wallet/deposit-service', () => ({
  ...jest.requireActual('../../src/services/wallet/deposit-service'),
  getDepositForUser: (...args: unknown[]) => mockGetDepositForUser(...args),
  createDeposit: (...args: unknown[]) => mockCreateDeposit(...args),
}));

import express from 'express';
import request from 'supertest';
import walletRouter from '../../src/routes/wallet';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', walletRouter);
  return app;
}

describe('GET /wallet/deposits/:id', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('on a real lookup error: returns 500 LOOKUP_FAILED, NOT 404 (the bug this fix closes)', async () => {
    mockGetDepositForUser.mockResolvedValue({ deposit: null, error: true });

    const res = await request(buildApp()).get('/api/v1/wallet/deposits/dep-1');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'LOOKUP_FAILED' });
  });

  it('on a genuine not-found: still returns 404 (unchanged)', async () => {
    mockGetDepositForUser.mockResolvedValue({ deposit: null });

    const res = await request(buildApp()).get('/api/v1/wallet/deposits/dep-missing');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: 'NOT_FOUND' });
  });

  it('on a successful fetch: returns the deposit (unchanged)', async () => {
    mockGetDepositForUser.mockResolvedValue({
      deposit: { id: 'dep-1', amount_minor: 500, currency: 'EUR', status: 'succeeded', failure_reason: null, created_at: '2026-01-01', updated_at: '2026-01-01' },
    });

    const res = await request(buildApp()).get('/api/v1/wallet/deposits/dep-1');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deposit.id).toBe('dep-1');
  });
});
