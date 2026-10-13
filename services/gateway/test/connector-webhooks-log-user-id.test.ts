/**
 * VTID-05174 (Health Hub D5 remainder, PLAT-D5R Change 6) — the success row
 * in connector_webhooks_log carries user_id when every normalized event of a
 * verified batch resolved to the same member, so erase_user_data() reaches it.
 * Mixed/unknown batches and the three failure sites (unknown connector,
 * handler error, invalid signature) stay NULL: their payload is unauthenticated.
 *
 * Every database call is mocked (the repository seam is auto-mocked).
 */

import express from 'express';
import request from 'supertest';

jest.mock('../src/lib/supabase', () => ({ getSupabase: jest.fn(() => ({})) }));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));
jest.mock('../src/services/health-sources/legacy-mirror', () => ({ dualWriteUserConnections: jest.fn() }));
jest.mock('../src/services/wearable-features-bridge', () => ({
  bridgeWearableDays: jest.fn(),
  isWearableFeatureBridgeEnabled: jest.fn(() => false),
  utcDateOf: jest.fn(() => null),
}));
jest.mock('../src/routes/connector-webhooks-repository');

const handleWebhook = jest.fn();
jest.mock('../src/connectors', () => ({
  getConnector: jest.fn((id: string) =>
    id === 'terra' ? { id: 'terra', display_name: 'Terra', handleWebhook: (...a: unknown[]) => handleWebhook(...a) } : undefined),
}));

import * as repo from '../src/routes/connector-webhooks-repository';
import router, { singleBatchMember } from '../src/routes/connector-webhooks';

const mockedRepo = repo as jest.Mocked<typeof repo>;
const U1 = '11111111-2222-4333-8444-555555555555';
const U2 = '99999999-2222-4333-8444-555555555555';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/connectors', router);
  return a;
}

function ev(user_id: string | null) {
  return { topic: 'connector.wearable.other', provider: 'terra', user_id, payload: {} };
}

function loggedRow(): Record<string, unknown> {
  expect(mockedRepo.insertConnectorWebhookLog).toHaveBeenCalledTimes(1);
  return mockedRepo.insertConnectorWebhookLog.mock.calls[0][1];
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockedRepo.insertConnectorWebhookLog.mockResolvedValue({ error: null } as never);
  mockedRepo.fetchUserConnectionForWebhook.mockResolvedValue({ data: null, error: null } as never);
});

describe('success log row user_id', () => {
  it('a single-member Terra batch logs that member', async () => {
    handleWebhook.mockResolvedValue({ valid: true, events: [ev(U1), ev(U1)] });
    const res = await request(app()).post('/api/v1/connectors/webhook/terra').send({ type: 'activity', user: { reference_id: U1 } });
    expect(res.status).toBe(200);
    expect(loggedRow()).toMatchObject({ signature_valid: true, processed: true, user_id: U1 });
  });

  it.each([
    ['mixed members', [ev(U1), ev(U2)]],
    ['one event unresolved', [ev(U1), ev(null)]],
    ['all unresolved', [ev(null)]],
    ['empty batch', []],
  ])('%s → NULL', async (_label, events) => {
    handleWebhook.mockResolvedValue({ valid: true, events });
    await request(app()).post('/api/v1/connectors/webhook/terra').send({ type: 'x' });
    expect(loggedRow().user_id).toBeNull();
  });
});

describe('failure log rows stay NULL', () => {
  it('unknown connector', async () => {
    const res = await request(app()).post('/api/v1/connectors/webhook/nope').send({ client_user_id: U1 });
    expect(res.status).toBe(404);
    expect(loggedRow().user_id).toBeUndefined();
  });

  it('handler error', async () => {
    handleWebhook.mockRejectedValue(new Error('boom'));
    const res = await request(app()).post('/api/v1/connectors/webhook/terra').send({ user: { reference_id: U1 } });
    expect(res.status).toBe(500);
    expect(loggedRow().user_id).toBeUndefined();
  });

  it('invalid signature, even when the claimed events name a member', async () => {
    handleWebhook.mockResolvedValue({ valid: false, error: 'bad signature', events: [ev(U1)] });
    const res = await request(app()).post('/api/v1/connectors/webhook/terra').send({ user: { reference_id: U1 } });
    expect(res.status).toBe(401);
    expect(loggedRow().user_id).toBeUndefined();
  });
});

describe('singleBatchMember', () => {
  it('pure helper', () => {
    expect(singleBatchMember([])).toBeNull();
    expect(singleBatchMember([{ user_id: U1 }])).toBe(U1);
    expect(singleBatchMember([{ user_id: U1 }, { user_id: U1 }])).toBe(U1);
    expect(singleBatchMember([{ user_id: U1 }, { user_id: U2 }])).toBeNull();
    expect(singleBatchMember([{ user_id: null }, { user_id: null }])).toBeNull();
    expect(singleBatchMember([{ user_id: U1 }, {}])).toBeNull();
  });
});
