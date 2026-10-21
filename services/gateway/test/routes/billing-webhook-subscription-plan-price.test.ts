/**
 * routes/billing.ts — POST /webhooks/stripe, customer.subscription.updated —
 * subscription_plan_prices error-visibility fix.
 *
 * handleSubscriptionUpserted() resolves plan_key from the Stripe Price ID
 * via repo.fetchPlanPriceByStripePriceId(), but previously destructured
 * only `{ data }`. On a Postgres-level failure (RLS/permission change,
 * table issue) supabase-js resolves normally with `{data:null, error}`
 * rather than throwing, so this silently fell through to the
 * `vitana_plan_key` metadata fallback (often 'free' — a Stripe-portal-
 * initiated plan change carries no custom metadata) and persisted the
 * wrong plan_key for a real subscriber via upsertUserSubscriptionFromStripe,
 * with zero trace. This pins that the error is now logged, while the
 * fallback behavior (and the deeper idempotency-vs-retry design, out of
 * scope) is unchanged.
 */

process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_BILLING_WEBHOOK_SECRET = 'whsec_test_dummy';

const mockConstructEvent = jest.fn();
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    webhooks: { constructEvent: (...args: unknown[]) => mockConstructEvent(...args) },
  }));
});

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => ({})),
}));

const mockInsertProcessedStripeEvent = jest.fn();
const mockFetchPlanPriceByStripePriceId = jest.fn();
const mockUpsertUserSubscriptionFromStripe = jest.fn();
jest.mock('../../src/routes/billing-repository', () => ({
  ...jest.requireActual('../../src/routes/billing-repository'),
  insertProcessedStripeEvent: (...args: unknown[]) => mockInsertProcessedStripeEvent(...args),
  fetchPlanPriceByStripePriceId: (...args: unknown[]) => mockFetchPlanPriceByStripePriceId(...args),
  upsertUserSubscriptionFromStripe: (...args: unknown[]) => mockUpsertUserSubscriptionFromStripe(...args),
}));

import express from 'express';
import request from 'supertest';
import billingRouter from '../../src/routes/billing';

function buildApp() {
  const app = express();
  app.use('/api/v1/billing/webhooks/stripe', express.raw({ type: 'application/json' }));
  app.use('/api/v1/billing', billingRouter);
  return app;
}

function fakeSubscriptionEvent(overrides: Partial<{ priceId: string; metadataPlanKey: string }> = {}) {
  return {
    id: 'evt_test_1',
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: 'sub_test_1',
        status: 'active',
        customer: 'cus_test_1',
        cancel_at_period_end: false,
        trial_end: null,
        metadata: {
          vitana_user_id: 'u1',
          vitana_tenant_id: 't1',
          ...(overrides.metadataPlanKey ? { vitana_plan_key: overrides.metadataPlanKey } : {}),
        },
        items: { data: [{ price: { id: overrides.priceId ?? 'price_test_1' }, current_period_start: 1700000000, current_period_end: 1702592000 }] },
      },
    },
  };
}

describe('POST /webhooks/stripe — customer.subscription.updated plan_key resolution', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockInsertProcessedStripeEvent.mockResolvedValue({ error: null });
    mockUpsertUserSubscriptionFromStripe.mockResolvedValue({ error: null });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('on fetchPlanPriceByStripePriceId returning {error}: logs it loudly, and still upserts using the metadata fallback (unchanged behavior)', async () => {
    const event = fakeSubscriptionEvent({ priceId: 'price_xyz', metadataPlanKey: undefined as any });
    mockConstructEvent.mockReturnValue(event);
    mockFetchPlanPriceByStripePriceId.mockResolvedValue({
      data: null,
      error: { message: 'permission denied for table subscription_plan_prices' },
    });

    const res = await request(buildApp())
      .post('/api/v1/billing/webhooks/stripe')
      .set('stripe-signature', 't=1,v1=fake')
      .set('Content-Type', 'application/json')
      .send(Buffer.from(JSON.stringify(event)));

    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('fetchPlanPriceByStripePriceId error for price=price_xyz: permission denied for table subscription_plan_prices'),
    );
    // Unchanged: falls through to the metadata fallback, which defaults to
    // 'free' when the subscription carries no vitana_plan_key metadata —
    // this is the exact silent-downgrade risk the fix makes observable,
    // not one this fix resolves on its own.
    expect(mockUpsertUserSubscriptionFromStripe).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ plan_key: 'free' }),
    );
  });

  it('on a successful lookup: logs nothing, and uses the resolved plan_key', async () => {
    const event = fakeSubscriptionEvent({ priceId: 'price_pro' });
    mockConstructEvent.mockReturnValue(event);
    mockFetchPlanPriceByStripePriceId.mockResolvedValue({
      data: { plan_key: 'pro', price_key: 'pro_monthly' },
      error: null,
    });

    const res = await request(buildApp())
      .post('/api/v1/billing/webhooks/stripe')
      .set('stripe-signature', 't=1,v1=fake')
      .set('Content-Type', 'application/json')
      .send(Buffer.from(JSON.stringify(event)));

    expect(res.status).toBe(200);
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('fetchPlanPriceByStripePriceId error'));
    expect(mockUpsertUserSubscriptionFromStripe).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ plan_key: 'pro', price_key: 'pro_monthly' }),
    );
  });
});
