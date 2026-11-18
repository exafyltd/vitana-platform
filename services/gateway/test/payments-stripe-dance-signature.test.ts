/**
 * VTID-05730 (plan gateway-critical-route-auth, lane stripe-dance-signature):
 * POST /webhooks/stripe-dance must verify the Stripe signature over the raw
 * body before any service_payments read or write.
 *
 * The app below mirrors index.ts: express.raw() for /webhooks/stripe-dance
 * mounted before express.json(), router mounted at '/'.
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import Stripe from 'stripe';

const mockFetch = jest.fn();
const mockUpdateState = jest.fn();
jest.mock('../src/routes/payments-stripe-webhook-repository', () => ({
  fetchServicePaymentByStripePiId: (...args: unknown[]) => mockFetch(...args),
  updateServicePaymentState: (...args: unknown[]) => mockUpdateState(...args),
}));

const mockSupabase = { from: jest.fn() };
jest.mock('../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => mockSupabase),
}));

const mockEmitOasisEvent = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: unknown[]) => mockEmitOasisEvent(...args),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const webhookRouter = require('../src/routes/payments-stripe-webhook').default;

const SECRET = 'whsec_test_stripe_dance_signature';
const PATH = '/webhooks/stripe-dance';

function makeApp() {
  const app = express();
  // Same order as services/gateway/src/index.ts: raw parser before express.json().
  app.use(PATH, express.raw({ type: 'application/json' }));
  app.use(express.json());
  app.use('/', webhookRouter);
  return app;
}

const fixtureEvent = {
  id: 'evt_dance_1',
  object: 'event',
  type: 'payment_intent.succeeded',
  created: 1700000000,
  data: { object: { id: 'pi_dance_1', object: 'payment_intent' } },
};
const payload = JSON.stringify(fixtureEvent);

function sign(body: string, secret = SECRET) {
  return Stripe.webhooks.generateTestHeaderString({ payload: body, secret });
}

function post(body: string, headers: Record<string, string> = {}) {
  let r = request(makeApp()).post(PATH).set('Content-Type', 'application/json');
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return r.send(body);
}

function expectNothingWritten() {
  expect(mockFetch).not.toHaveBeenCalled();
  expect(mockUpdateState).not.toHaveBeenCalled();
  expect(mockSupabase.from).not.toHaveBeenCalled();
  expect(mockEmitOasisEvent).not.toHaveBeenCalled();
}

describe('POST /webhooks/stripe-dance signature verification', () => {
  const savedSecret = process.env.STRIPE_WEBHOOK_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    mockFetch.mockResolvedValue({
      data: { payment_id: 'pay_dance_1', payer_vitana_id: 'u1', payee_vitana_id: 'u2', state: 'pending' },
      error: null,
    });
    mockUpdateState.mockResolvedValue({ error: null });
  });

  afterAll(() => {
    if (savedSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = savedSecret;
  });

  it('valid signature → 200 and the service_payments state moves', async () => {
    const res = await post(payload, { 'stripe-signature': sign(payload) });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, payment_id: 'pay_dance_1', state: 'authorized' });
    expect(mockFetch).toHaveBeenCalledWith(mockSupabase, 'pi_dance_1');
    expect(mockUpdateState).toHaveBeenCalledWith(mockSupabase, 'pay_dance_1', 'authorized');
  });

  it('forged signature (signed with another secret) → 400 BAD_SIGNATURE, nothing written', async () => {
    const res = await post(payload, { 'stripe-signature': sign(payload, 'whsec_attacker') });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'BAD_SIGNATURE' });
    expectNothingWritten();
  });

  it('garbage signature header → 400 BAD_SIGNATURE, nothing written', async () => {
    const res = await post(payload, { 'stripe-signature': 't=1,v1=deadbeef' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'BAD_SIGNATURE' });
    expectNothingWritten();
  });

  it('missing stripe-signature header → 400, nothing written', async () => {
    const res = await post(payload);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false });
    expectNothingWritten();
  });

  it('STRIPE_WEBHOOK_SECRET unset → 500 WEBHOOK_NOT_CONFIGURED, nothing written', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const res = await post(payload, { 'stripe-signature': sign(payload) });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ ok: false, error: 'WEBHOOK_NOT_CONFIGURED' });
    expectNothingWritten();
  });

  // Behaviours of test/routes/payments-stripe-webhook.test.ts, re-expressed with signed events.
  it('signed event, lookup error → 500 LOOKUP_FAILED, no state write', async () => {
    mockFetch.mockResolvedValueOnce({ data: null, error: { message: 'db down' } });
    const res = await post(payload, { 'stripe-signature': sign(payload) });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ ok: false, error: 'LOOKUP_FAILED' });
    expect(mockUpdateState).not.toHaveBeenCalled();
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
  });

  it('signed event, unknown payment_intent → 200 unknown_pi, no state write', async () => {
    mockFetch.mockResolvedValueOnce({ data: null, error: null });
    const res = await post(payload, { 'stripe-signature': sign(payload) });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, unknown_pi: true });
    expect(mockUpdateState).not.toHaveBeenCalled();
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ status: 'info' }));
  });

  it('body altered after signing → 400 BAD_SIGNATURE, nothing written', async () => {
    const header = sign(payload);
    const altered = JSON.stringify({
      ...fixtureEvent,
      data: { object: { id: 'pi_someone_else', object: 'payment_intent' } },
    });
    const res = await post(altered, { 'stripe-signature': header });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'BAD_SIGNATURE' });
    expectNothingWritten();
  });

  it('index.ts mounts express.raw for /webhooks/stripe-dance before express.json()', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    const raw = src.indexOf("app.use('/webhooks/stripe-dance', express.raw({ type: 'application/json' }))");
    const json = src.indexOf("app.use(express.json({ limit: '2mb' }))");
    expect(raw).toBeGreaterThan(-1);
    expect(json).toBeGreaterThan(raw);
  });
});
