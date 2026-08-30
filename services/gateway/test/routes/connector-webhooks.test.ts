/**
 * routes/connector-webhooks.ts — first test coverage for the wearable
 * webhook receiver (previously "impact-allow-no-test", zero coverage).
 *
 * Focused on one fix: fetchUserConnectionForWebhook's `error` was
 * previously unchecked. A real DB error there silently resolved `conn` to
 * undefined — identical to "no connection row" — which drops `tenantId`
 * and makes every downstream wearable-data upsert (sleep/activity/workout)
 * a silent no-op, while `persisted++` still counted the event and the
 * webhook acked 200 — so the provider never retries and the health data
 * is permanently lost with no visible failure anywhere.
 */
import express from 'express';
import request from 'supertest';

const mockMaybeSingle = jest.fn();
const mockLimit = jest.fn(() => ({ maybeSingle: mockMaybeSingle }));
const mockEq2 = jest.fn(() => ({ limit: mockLimit }));
const mockEq1 = jest.fn(() => ({ eq: mockEq2 }));
const mockSelect = jest.fn(() => ({ eq: mockEq1 }));
const mockUpsert = jest.fn().mockResolvedValue({ error: null });
const mockInsert = jest.fn().mockResolvedValue({ error: null });
const mockFrom = jest.fn(() => ({ select: mockSelect, upsert: mockUpsert, insert: mockInsert }));
const mockSupabase = { from: mockFrom };

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => mockSupabase),
}));

const mockEmitOasisEvent = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: unknown[]) => mockEmitOasisEvent(...args),
}));

const mockHandleWebhook = jest.fn();
jest.mock('../../src/connectors', () => ({
  getConnector: jest.fn(() => ({
    id: 'terra',
    display_name: 'Terra',
    handleWebhook: (...args: unknown[]) => mockHandleWebhook(...args),
  })),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const webhookRouter = require('../../src/routes/connector-webhooks').default;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/connectors', webhookRouter);
  return app;
}

const SLEEP_EVENT = {
  topic: 'connector.wearable.sleep.recorded',
  user_id: 'user-1',
  provider: 'terra',
  payload: { metric_date: '2026-08-29', sleep_minutes: 420 },
};

describe('connector-webhooks — POST /webhook/:connectorId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMaybeSingle.mockResolvedValue({ data: { id: 'conn-1', tenant_id: 'tenant-1' }, error: null });
    mockUpsert.mockResolvedValue({ error: null });
    mockInsert.mockResolvedValue({ error: null });
  });

  it('persists a wearable data event and upserts daily metrics, unchanged happy path', async () => {
    mockHandleWebhook.mockResolvedValue({ valid: true, events: [SLEEP_EVENT] });

    const res = await request(makeApp()).post('/api/v1/connectors/webhook/terra').send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, processed: 1, skipped: 0 });
    expect(mockUpsert).toHaveBeenCalled();
  });

  it('counts the event as skipped (not persisted) when the user_connection lookup errors, and does NOT silently drop the data upsert', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: { message: 'connection reset' } });
    mockHandleWebhook.mockResolvedValue({ valid: true, events: [SLEEP_EVENT] });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await request(makeApp()).post('/api/v1/connectors/webhook/terra').send({});

    expect(res.status).toBe(200);
    // Previously this reported persisted:1 (a false success) while silently
    // never calling upsertWearableDailyMetrics because tenantId was undefined.
    expect(res.body).toMatchObject({ ok: true, processed: 0, skipped: 1 });
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('event persist failed'));
    warnSpy.mockRestore();
  });
});
