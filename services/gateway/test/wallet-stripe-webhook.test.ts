/**
 * Wallet Stripe webhook handler — VTID-03201
 *
 * These tests lock down the security + idempotency contract. The actual
 * money-moving logic lives in the credit_deposit DB RPC and is exercised in
 * integration tests; here we verify the gateway behavior:
 *
 *   1. Missing signature header → 400, no DB write
 *   2. Invalid signature → 400, no DB write
 *   3. First delivery of a valid event → insert event row + dispatch handler
 *   4. Replay of the same stripe_event_id → 200, no second dispatch
 *   5. Unhandled event type → 200 with ignored=true, marked processed
 *   6. Missing/invalid metadata on checkout.session.completed → no credit attempt
 *   7. Handler error → 500 (Stripe will retry; idempotency makes retries safe)
 */

import express from 'express';
import request from 'supertest';
import Stripe from 'stripe';

// ---- Mocks set up BEFORE importing the router ----
const mockInsert = jest.fn();
const mockUpdate = jest.fn();
const mockEq = jest.fn();
const mockMaybeSingle = jest.fn();

const supabaseFromTable = jest.fn((_table: string) => ({
  insert: mockInsert,
  update: mockUpdate,
  select: jest.fn(() => ({ eq: mockEq })),
}));

const mockSupabase = {
  from: supabaseFromTable,
  rpc: jest.fn().mockResolvedValue({ data: { ok: true, duplicate: false, balance_minor: 5000 }, error: null }),
};

jest.mock('../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => mockSupabase),
}));

// Stub the wallet stripe client so we control signature verification.
const mockConstructEvent = jest.fn();
const stubStripe = {
  webhooks: { constructEvent: mockConstructEvent },
} as unknown as Stripe;

jest.mock('../src/services/wallet/stripe-client', () => ({
  getWalletStripe: () => stubStripe,
  getWalletWebhookSecret: () => 'whsec_test_secret',
  getAppBaseUrl: () => 'https://test.local',
  getEnvironmentTag: () => 'test',
  __setWalletStripeForTests: () => undefined,
}));

// finalizeDeposit + markDepositTerminal are deposit-service exports; spy on
// them so we can assert dispatch behavior without exercising RPCs.
const mockFinalizeDeposit = jest.fn().mockResolvedValue({
  ok: true,
  duplicate: false,
  balance_minor: 5000,
  currency: 'EUR',
});
const mockMarkDepositTerminal = jest.fn().mockResolvedValue(undefined);

jest.mock('../src/services/wallet/deposit-service', () => ({
  finalizeDeposit: (...args: unknown[]) => mockFinalizeDeposit(...args),
  markDepositTerminal: (...args: unknown[]) => mockMarkDepositTerminal(...args),
  DepositServiceError: class extends Error {
    constructor(public code: string, message: string, public httpStatus = 400) {
      super(message);
    }
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const webhookRouter = require('../src/routes/wallet-stripe-webhook').default;

function makeApp() {
  const app = express();
  // Mirror production: raw body for the webhook path.
  app.use('/api/v1/stripe/webhook', express.raw({ type: 'application/json' }));
  app.use('/api/v1/stripe', webhookRouter);
  return app;
}

const SAMPLE_DEPOSIT_ID = '11111111-1111-1111-1111-111111111111';
const SAMPLE_USER_ID = '22222222-2222-2222-2222-222222222222';
const SAMPLE_ACCOUNT_ID = '33333333-3333-3333-3333-333333333333';

function checkoutCompletedEvent(opts: { id?: string; metadata?: Record<string, string> | null } = {}): Stripe.Event {
  return {
    id: opts.id ?? 'evt_test_1',
    type: 'checkout.session.completed',
    object: 'event',
    data: {
      object: {
        id: 'cs_test_1',
        payment_status: 'paid',
        payment_intent: 'pi_test_1',
        metadata: opts.metadata === undefined
          ? {
              schema_version: '1',
              vitana_user_id: SAMPLE_USER_ID,
              account_id: SAMPLE_ACCOUNT_ID,
              deposit_id: SAMPLE_DEPOSIT_ID,
              currency: 'EUR',
              environment: 'test',
            }
          : opts.metadata,
      },
    },
  } as unknown as Stripe.Event;
}

describe('wallet-stripe-webhook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: event insert succeeds (no duplicate).
    mockInsert.mockResolvedValue({ error: null });
    // Default: update chain returns ok.
    mockUpdate.mockReturnValue({ eq: jest.fn().mockResolvedValue({ error: null }) });
    // Default: eq chain returns ok.
    mockEq.mockReturnValue({ maybeSingle: mockMaybeSingle });
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
  });

  it('rejects requests with no stripe-signature header', async () => {
    const res = await request(makeApp())
      .post('/api/v1/stripe/webhook/wallet')
      .set('Content-Type', 'application/json')
      .send(Buffer.from('{}'));
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockFinalizeDeposit).not.toHaveBeenCalled();
  });

  it('rejects requests whose signature fails verification', async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error('Invalid signature');
    });
    const res = await request(makeApp())
      .post('/api/v1/stripe/webhook/wallet')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'bogus')
      .send(Buffer.from('{}'));
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockFinalizeDeposit).not.toHaveBeenCalled();
  });

  it('credits a valid checkout.session.completed once on first delivery', async () => {
    mockConstructEvent.mockReturnValue(checkoutCompletedEvent());
    const res = await request(makeApp())
      .post('/api/v1/stripe/webhook/wallet')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'valid')
      .send(Buffer.from('{}'));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true });
    expect(supabaseFromTable).toHaveBeenCalledWith('stripe_webhook_events');
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockFinalizeDeposit).toHaveBeenCalledWith(SAMPLE_DEPOSIT_ID, 'evt_test_1', 'pi_test_1');
  });

  it('returns 200 + duplicate=true on replayed stripe_event_id without re-dispatching', async () => {
    mockConstructEvent.mockReturnValue(checkoutCompletedEvent());
    // Simulate the unique-violation Postgres returns on duplicate stripe_event_id.
    mockInsert.mockResolvedValueOnce({ error: { code: '23505', message: 'duplicate key' } });

    const res = await request(makeApp())
      .post('/api/v1/stripe/webhook/wallet')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'valid')
      .send(Buffer.from('{}'));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, duplicate: true });
    expect(mockFinalizeDeposit).not.toHaveBeenCalled();
  });

  it('ignores unhandled event types but still marks them processed', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_test_unhandled',
      type: 'customer.subscription.updated',
      data: { object: {} },
    } as unknown as Stripe.Event);

    const res = await request(makeApp())
      .post('/api/v1/stripe/webhook/wallet')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'valid')
      .send(Buffer.from('{}'));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, ignored: true });
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockFinalizeDeposit).not.toHaveBeenCalled();
    // Marked processed (update on stripe_webhook_events).
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('does not credit when checkout.session.completed metadata is missing required fields', async () => {
    mockConstructEvent.mockReturnValue(
      checkoutCompletedEvent({ metadata: { schema_version: '1', currency: 'EUR' } as Record<string, string> })
    );

    const res = await request(makeApp())
      .post('/api/v1/stripe/webhook/wallet')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'valid')
      .send(Buffer.from('{}'));

    expect(res.status).toBe(200);
    expect(mockFinalizeDeposit).not.toHaveBeenCalled();
  });

  it('does not credit when payment_status is not "paid"', async () => {
    const event = checkoutCompletedEvent();
    (event.data.object as Stripe.Checkout.Session).payment_status = 'unpaid' as never;
    mockConstructEvent.mockReturnValue(event);

    const res = await request(makeApp())
      .post('/api/v1/stripe/webhook/wallet')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'valid')
      .send(Buffer.from('{}'));

    expect(res.status).toBe(200);
    expect(mockFinalizeDeposit).not.toHaveBeenCalled();
  });

  it('marks deposit expired on checkout.session.expired', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_test_expired',
      type: 'checkout.session.expired',
      data: {
        object: {
          id: 'cs_test_x',
          metadata: {
            schema_version: '1',
            vitana_user_id: SAMPLE_USER_ID,
            account_id: SAMPLE_ACCOUNT_ID,
            deposit_id: SAMPLE_DEPOSIT_ID,
            currency: 'EUR',
            environment: 'test',
          },
        },
      },
    } as unknown as Stripe.Event);

    const res = await request(makeApp())
      .post('/api/v1/stripe/webhook/wallet')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'valid')
      .send(Buffer.from('{}'));

    expect(res.status).toBe(200);
    expect(mockMarkDepositTerminal).toHaveBeenCalledWith(SAMPLE_DEPOSIT_ID, 'expired', expect.any(String));
    expect(mockFinalizeDeposit).not.toHaveBeenCalled();
  });

  it('returns 500 when the handler throws (Stripe will retry)', async () => {
    mockConstructEvent.mockReturnValue(checkoutCompletedEvent());
    mockFinalizeDeposit.mockRejectedValueOnce(new Error('rpc explode'));

    const res = await request(makeApp())
      .post('/api/v1/stripe/webhook/wallet')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'valid')
      .send(Buffer.from('{}'));

    expect(res.status).toBe(500);
    // Event row should still be marked processed with an error message.
    expect(mockUpdate).toHaveBeenCalled();
  });
});
