/**
 * VTID-05089 (Health Hub D6a) — the webhook route calls the wearable features
 * bridge once per distinct user, after the event loop, only when the flag is
 * on, and a bridge failure never changes the webhook response.
 */
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: jest.fn() };
jest.mock('../../src/lib/supabase', () => ({ getSupabase: jest.fn(() => mockSupabase) }));

jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(async () => ({ ok: true })),
}));

const mockHandleWebhook = jest.fn();
jest.mock('../../src/connectors', () => ({
  getConnector: jest.fn(() => ({
    id: 'terra',
    display_name: 'Terra',
    handleWebhook: (...args: unknown[]) => mockHandleWebhook(...args),
  })),
}));

jest.mock('../../src/routes/connector-webhooks-repository', () => ({
  insertConnectorWebhookLog: jest.fn(async () => ({ error: null })),
  fetchUserConnectionForWebhook: jest.fn(),
  updateUserConnectionState: jest.fn(async () => ({ error: null })),
  upsertWearableDailyMetrics: jest.fn(async () => ({ error: null })),
  upsertWearableWorkout: jest.fn(async () => ({ error: null })),
}));

const mockBridge = jest.fn();
jest.mock('../../src/services/wearable-features-bridge', () => {
  const actual = jest.requireActual('../../src/services/wearable-features-bridge');
  return { ...actual, bridgeWearableDays: (...args: unknown[]) => mockBridge(...args) };
});

import * as repo from '../../src/routes/connector-webhooks-repository';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const webhookRouter = require('../../src/routes/connector-webhooks').default;

const mockedRepo = repo as jest.Mocked<typeof repo>;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/connectors', webhookRouter);
  return app;
}

const SLEEP = {
  topic: 'connector.wearable.sleep.recorded',
  user_id: 'user-1',
  provider: 'oura',
  payload: { metric_date: '2026-10-11', sleep_minutes: 437 },
};
const ACTIVITY = {
  topic: 'connector.wearable.activity.recorded',
  user_id: 'user-1',
  provider: 'oura',
  payload: { metric_date: '2026-10-10', steps: 12345 },
};
const WORKOUT = {
  topic: 'connector.wearable.workout.recorded',
  user_id: 'user-1',
  provider: 'oura',
  payload: { external_workout_id: 'w1', started_at: '2026-10-09T23:30:00+00:00' },
};
const OTHER_USER_SLEEP = { ...SLEEP, user_id: 'user-2' };

const ENV_KEYS = ['WEARABLE_FEATURE_BRIDGE_ENABLED', 'VITANA_ENV'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  delete process.env.VITANA_ENV;
  process.env.WEARABLE_FEATURE_BRIDGE_ENABLED = 'true';
  mockedRepo.fetchUserConnectionForWebhook.mockImplementation((async (_sb: unknown, userId: string) =>
    userId === 'no-conn-user'
      ? { data: null, error: null }
      : { data: { id: `conn-${userId}`, tenant_id: 'tenant-1' }, error: null }) as never);
  mockedRepo.upsertWearableDailyMetrics.mockResolvedValue({ error: null } as never);
  mockedRepo.upsertWearableWorkout.mockResolvedValue({ error: null } as never);
  mockBridge.mockResolvedValue({ ok: true, features_written: 1, days: 1, index_recomputed: true });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('connector-webhooks -> wearable features bridge (VTID-05089)', () => {
  it('flag on: persists daily metrics, then calls the bridge once per user with the persisted dates', async () => {
    mockHandleWebhook.mockResolvedValue({ valid: true, events: [SLEEP, ACTIVITY, WORKOUT, OTHER_USER_SLEEP] });

    const res = await request(makeApp()).post('/api/v1/connectors/webhook/terra').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, processed: 4, skipped: 0 });
    expect(mockedRepo.upsertWearableDailyMetrics).toHaveBeenCalledTimes(3);
    expect(mockBridge).toHaveBeenCalledTimes(2);
    const byUser = Object.fromEntries(mockBridge.mock.calls.map((c) => [c[1].userId, c[1]]));
    expect(byUser['user-1'].tenantId).toBe('tenant-1');
    expect([...byUser['user-1'].dates].sort()).toEqual(['2026-10-09', '2026-10-10', '2026-10-11']);
    expect(byUser['user-2'].dates).toEqual(['2026-10-11']);
    // The bridge runs after the loop: every upsert happened before the first bridge call.
    const lastUpsert = Math.max(...mockedRepo.upsertWearableDailyMetrics.mock.invocationCallOrder);
    expect(Math.min(...mockBridge.mock.invocationCallOrder)).toBeGreaterThan(lastUpsert);
    expect(mockBridge.mock.calls[0][0]).toBe(mockSupabase);
  });

  it('a row whose upsert errored is not bridged', async () => {
    mockedRepo.upsertWearableDailyMetrics.mockResolvedValueOnce({ error: { message: 'x' } } as never);
    mockHandleWebhook.mockResolvedValue({ valid: true, events: [SLEEP, ACTIVITY] });

    await request(makeApp()).post('/api/v1/connectors/webhook/terra').send({});

    expect(mockBridge).toHaveBeenCalledTimes(1);
    expect(mockBridge.mock.calls[0][1].dates).toEqual(['2026-10-10']);
  });

  it.each([
    ['absent', undefined, undefined],
    ["'false'", 'false', undefined],
    ["'true' on staging", 'true', 'staging'],
  ])('flag %s: the bridge is not called', async (_l, flag, vitanaEnv) => {
    if (flag === undefined) delete process.env.WEARABLE_FEATURE_BRIDGE_ENABLED;
    else process.env.WEARABLE_FEATURE_BRIDGE_ENABLED = flag;
    if (vitanaEnv) process.env.VITANA_ENV = vitanaEnv;
    mockHandleWebhook.mockResolvedValue({ valid: true, events: [SLEEP] });

    const res = await request(makeApp()).post('/api/v1/connectors/webhook/terra').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, processed: 1, skipped: 0 });
    expect(mockedRepo.upsertWearableDailyMetrics).toHaveBeenCalledTimes(1);
    expect(mockBridge).not.toHaveBeenCalled();
  });

  it('the bridge throwing never changes the response', async () => {
    mockBridge.mockRejectedValue(new Error('bridge exploded'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockHandleWebhook.mockResolvedValue({ valid: true, events: [SLEEP] });

    const res = await request(makeApp()).post('/api/v1/connectors/webhook/terra').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, processed: 1, skipped: 0 });
    expect(mockBridge).toHaveBeenCalledTimes(1);
    expect(mockedRepo.insertConnectorWebhookLog).toHaveBeenCalledWith(mockSupabase, expect.objectContaining({ processed: true }));
    warn.mockRestore();
  });

  it('the bridge resolving ok:false never changes the response', async () => {
    mockBridge.mockResolvedValue({ ok: false, error_code: 'insert_features_failed' });
    mockHandleWebhook.mockResolvedValue({ valid: true, events: [SLEEP] });

    const res = await request(makeApp()).post('/api/v1/connectors/webhook/terra').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, processed: 1, skipped: 0 });
  });

  it('an event with no tenant (no connection row) is not bridged', async () => {
    mockHandleWebhook.mockResolvedValue({ valid: true, events: [{ ...SLEEP, user_id: 'no-conn-user' }] });

    const res = await request(makeApp()).post('/api/v1/connectors/webhook/terra').send({});

    expect(res.status).toBe(200);
    expect(mockedRepo.upsertWearableDailyMetrics).not.toHaveBeenCalled();
    expect(mockBridge).not.toHaveBeenCalled();
  });

  it('auth-only events (no data rows) do not call the bridge', async () => {
    mockHandleWebhook.mockResolvedValue({
      valid: true,
      events: [{ topic: 'connector.wearable.auth.completed', user_id: 'user-1', provider: 'oura', payload: {} }],
    });

    await request(makeApp()).post('/api/v1/connectors/webhook/terra').send({});

    expect(mockBridge).not.toHaveBeenCalled();
  });
});
