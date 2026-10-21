/**
 * routes/billing.ts — POST /checkout/subscription — trial_days lookup
 * error-visibility fix (BOOTSTRAP-AURORA-CUTOVER).
 *
 * fetchSubscriptionPlanTrialDays()'s `error` was previously discarded, so a
 * real DB failure was indistinguishable from "this plan has no trial
 * configured" — both resolved trialDays to 0 via `?? 0`, silently charging
 * the customer immediately on a checkout their plan is actually configured
 * to offer a trial for. This is billing-correctness-critical, so the fix
 * fails the checkout attempt closed (500) before any Stripe session is
 * created, rather than risk charging on a real DB error.
 */

process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';

const mockCustomersCreate = jest.fn();
const mockSessionsCreate = jest.fn();
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    customers: { create: (...args: unknown[]) => mockCustomersCreate(...args) },
    checkout: { sessions: { create: (...args: unknown[]) => mockSessionsCreate(...args) } },
  }));
});

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => ({})),
}));

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  ...jest.requireActual('../../src/middleware/auth-supabase-jwt'),
  requireAuth: (req: any, _res: any, next: () => void) => {
    req.identity = { user_id: 'u1', tenant_id: 't1', email: 'u1@example.com' };
    next();
  },
}));

const mockFetchActivePriceByKey = jest.fn();
const mockFetchUserSubscription = jest.fn();
const mockFetchSubscriptionPlanTrialDays = jest.fn();
const mockUpsertUserSubscriptionCustomerId = jest.fn();
jest.mock('../../src/routes/billing-repository', () => ({
  ...jest.requireActual('../../src/routes/billing-repository'),
  fetchActivePriceByKey: (...args: unknown[]) => mockFetchActivePriceByKey(...args),
  fetchUserSubscription: (...args: unknown[]) => mockFetchUserSubscription(...args),
  fetchSubscriptionPlanTrialDays: (...args: unknown[]) => mockFetchSubscriptionPlanTrialDays(...args),
  upsertUserSubscriptionCustomerId: (...args: unknown[]) => mockUpsertUserSubscriptionCustomerId(...args),
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

const PRICE_ROW = {
  price_key: 'price-1', plan_key: 'plan-1', billing_interval: 'month',
  price_cents: 999, currency: 'eur', stripe_price_id: 'price_stripe_1',
};

describe('POST /checkout/subscription — fetchSubscriptionPlanTrialDays error handling', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockFetchActivePriceByKey.mockResolvedValue({ data: PRICE_ROW, error: null });
    // No existing subscription (both the pre-check and ensureStripeCustomer's
    // own lookup go through this same repo call).
    mockFetchUserSubscription.mockResolvedValue({ data: null, error: null });
    mockUpsertUserSubscriptionCustomerId.mockResolvedValue({ error: null });
    mockCustomersCreate.mockResolvedValue({ id: 'cus_new_1' });
    mockSessionsCreate.mockResolvedValue({ id: 'cs_test_1', url: 'https://checkout.stripe.com/cs_test_1' });
  });

  afterEach(() => errorSpy.mockRestore());

  it('a real DB error fails the checkout closed (500 TRIAL_LOOKUP_FAILED) instead of silently charging with trialDays=0', async () => {
    mockFetchSubscriptionPlanTrialDays.mockResolvedValue({
      data: null,
      error: { message: 'connection terminated unexpectedly' },
    });

    const res = await request(buildApp())
      .post('/api/v1/billing/checkout/subscription')
      .send({ price_key: 'price-1' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'TRIAL_LOOKUP_FAILED', vtid: 'VTID-03107' });
    expect(mockSessionsCreate).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('trial_days lookup failed'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('connection terminated unexpectedly'));
  });

  it('a plan genuinely configured with no trial (no error, null row) still checks out at trialDays=0 — unchanged', async () => {
    mockFetchSubscriptionPlanTrialDays.mockResolvedValue({ data: null, error: null });

    const res = await request(buildApp())
      .post('/api/v1/billing/checkout/subscription')
      .send({ price_key: 'price-1' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockSessionsCreate).toHaveBeenCalledTimes(1);
    expect(mockSessionsCreate.mock.calls[0][0].subscription_data.trial_period_days).toBeUndefined();
  });

  it('a plan with a real trial_days value still honors the trial — unchanged', async () => {
    mockFetchSubscriptionPlanTrialDays.mockResolvedValue({ data: { trial_days: 14 }, error: null });

    const res = await request(buildApp())
      .post('/api/v1/billing/checkout/subscription')
      .send({ price_key: 'price-1' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockSessionsCreate.mock.calls[0][0].subscription_data.trial_period_days).toBe(14);
  });
});
