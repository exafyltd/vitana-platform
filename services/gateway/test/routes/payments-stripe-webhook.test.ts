/**
 * routes/payments-stripe-webhook.ts (VTID-DANCE-D6 scaffold) — first test
 * coverage for this route (previously zero, per its own repository
 * file's "impact-allow-no-test... zero coverage today" note).
 *
 * Focused on one fix: fetchServicePaymentByStripePiId's `error` was
 * previously unchecked, so a real DB failure was indistinguishable from
 * "unknown payment_intent" and logged at status:'info' — meaning the
 * service_payments row silently never advances and nobody is alerted.
 */
import express from 'express';
import request from 'supertest';

const mockMaybeSingle = jest.fn();
const mockEq = jest.fn(() => ({ maybeSingle: mockMaybeSingle }));
const mockSelect = jest.fn(() => ({ eq: mockEq }));
const mockUpdateEq = jest.fn().mockResolvedValue({ error: null });
const mockUpdate = jest.fn(() => ({ eq: mockUpdateEq }));
const mockFrom = jest.fn(() => ({ select: mockSelect, update: mockUpdate }));
const mockSupabase = { from: mockFrom };

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => mockSupabase),
}));

const mockEmitOasisEvent = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: unknown[]) => mockEmitOasisEvent(...args),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const webhookRouter = require('../../src/routes/payments-stripe-webhook').default;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/', webhookRouter);
  return app;
}

describe('payments-stripe-webhook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    mockUpdateEq.mockResolvedValue({ error: null });
  });

  it('returns 500 (not "unknown payment_intent") when the service_payments lookup errors', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: { message: 'db down' } });

    const res = await request(makeApp())
      .post('/webhooks/stripe-dance')
      .send({ id: 'evt_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1' } }, created: 0 });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ ok: false, error: 'LOOKUP_FAILED' });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', message: expect.stringContaining('lookup failed') }),
    );
  });

  it('acks unknown-but-not-erroring payment_intent as info, unchanged', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const res = await request(makeApp())
      .post('/webhooks/stripe-dance')
      .send({ id: 'evt_2', type: 'payment_intent.succeeded', data: { object: { id: 'pi_2' } }, created: 0 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, unknown_pi: true });
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ status: 'info' }));
  });

  it('advances state on a found payment, unchanged', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { payment_id: 'pay_1', state: 'pending' }, error: null });

    const res = await request(makeApp())
      .post('/webhooks/stripe-dance')
      .send({ id: 'evt_3', type: 'payment_intent.succeeded', data: { object: { id: 'pi_3' } }, created: 0 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(mockUpdate).toHaveBeenCalledWith({ state: 'authorized', updated_at: expect.any(String) });
  });
});
