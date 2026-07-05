/**
 * Stripe Connect webhook — VTID-01250 dispatch wiring.
 *
 * On a real charges_enabled false->true transition, the webhook now
 * dispatches 'user.business.started' so AP-1106/AP-1504 actually fire —
 * previously nothing in the codebase ever called dispatchEvent for that
 * topic, so both automations were dead despite being marked IMPLEMENTED.
 */

import request from 'supertest';
import express from 'express';

// STRIPE_CONNECT_WEBHOOK_SECRET is read at module-load time in
// stripe-connect-webhook.ts, so it must be set before that module (and its
// import chain) is required.
process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_test';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';

jest.mock('../../src/services/automation-executor', () => ({
  dispatchEvent: jest.fn().mockResolvedValue({ executed: [], skipped: [], failed: [] }),
}));

const mockConstructEvent = jest.fn();
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    webhooks: { constructEvent: (...args: any[]) => mockConstructEvent(...args) },
  }));
});

import stripeConnectWebhookRouter from '../../src/routes/stripe-connect-webhook';
import { dispatchEvent } from '../../src/services/automation-executor';

const mockDispatchEvent = dispatchEvent as jest.MockedFunction<typeof dispatchEvent>;

const testApp = express();
testApp.use(express.raw({ type: '*/*' }));
testApp.use('/', stripeConnectWebhookRouter);

describe('POST /webhook/connect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';
    global.fetch = jest.fn();
  });

  it('dispatches user.business.started on a real charges_enabled false->true transition', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ user_id: 'u1', tenant_id: 't1', stripe_charges_enabled: false }],
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    mockConstructEvent.mockReturnValue({
      type: 'account.updated',
      data: { object: { id: 'acct_123', charges_enabled: true, payouts_enabled: true } },
    });

    const res = await request(testApp)
      .post('/webhook/connect')
      .set('stripe-signature', 'sig')
      .send(Buffer.from('{}'));

    expect(res.status).toBe(200);
    expect(mockDispatchEvent).toHaveBeenCalledWith('t1', 'user.business.started', { user_id: 'u1' });
  });

  it('does not dispatch when charges_enabled was already true', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ user_id: 'u1', tenant_id: 't1', stripe_charges_enabled: true }],
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    mockConstructEvent.mockReturnValue({
      type: 'account.updated',
      data: { object: { id: 'acct_123', charges_enabled: true, payouts_enabled: true } },
    });

    const res = await request(testApp)
      .post('/webhook/connect')
      .set('stripe-signature', 'sig')
      .send(Buffer.from('{}'));

    expect(res.status).toBe(200);
    expect(mockDispatchEvent).not.toHaveBeenCalled();
  });

  it('does not dispatch when the DB update RPC fails', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ user_id: 'u1', tenant_id: 't1', stripe_charges_enabled: false }],
      })
      .mockResolvedValueOnce({ ok: false, text: async () => 'db error' });

    mockConstructEvent.mockReturnValue({
      type: 'account.updated',
      data: { object: { id: 'acct_123', charges_enabled: true, payouts_enabled: true } },
    });

    const res = await request(testApp)
      .post('/webhook/connect')
      .set('stripe-signature', 'sig')
      .send(Buffer.from('{}'));

    expect(res.status).toBe(200);
    expect(mockDispatchEvent).not.toHaveBeenCalled();
  });
});
