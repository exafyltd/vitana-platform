/**
 * VTID-05162 (Health Hub Phase 1 / B2) — Change 7 at the call sites: every
 * writer calls recordToHealthStore only after its legacy write succeeded, with
 * its writer id, identity and source_record_id inputs; and whatever
 * recordToHealthStore answers (skipped, a call-level STORE_* failure, or even a
 * rejection) the legacy response / tool result is byte-identical.
 * recordToHealthStore itself is covered by record-to-health-store.test.ts.
 */
import express from 'express';
import request from 'supertest';

const mockRecord = jest.fn();
jest.mock('../../src/services/health-features/record-to-health-store', () => ({
  recordToHealthStore: (...args: unknown[]) => mockRecord(...args),
}));

const mockSupabase = { from: jest.fn(), rpc: jest.fn() };
jest.mock('../../src/lib/supabase', () => ({ getSupabase: jest.fn(() => mockSupabase) }));
jest.mock('../../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));
jest.mock('../../src/services/health-sources/legacy-mirror', () => ({
  dualWriteUserIntegration: jest.fn(() => null),
  dualWriteUserConnections: jest.fn(() => null),
}));
jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => mockSupabase) }));

// ---- webhook route --------------------------------------------------------------
const mockHandleWebhook = jest.fn();
jest.mock('../../src/connectors', () => ({
  getConnector: jest.fn(() => ({ id: 'oura', display_name: 'Oura', handleWebhook: (...a: unknown[]) => mockHandleWebhook(...a) })),
}));
jest.mock('../../src/routes/connector-webhooks-repository', () => ({
  insertConnectorWebhookLog: jest.fn(async () => ({ error: null })),
  fetchUserConnectionForWebhook: jest.fn(async () => ({ data: { id: 'conn-1', tenant_id: 'tenant-1' }, error: null })),
  updateUserConnectionState: jest.fn(async () => ({ error: null })),
  upsertWearableDailyMetrics: jest.fn(async () => ({ error: null })),
  upsertWearableWorkout: jest.fn(async () => ({ error: null })),
}));

// ---- voice / ORB / diary / manual / action repositories -----------------------------
jest.mock('../../src/services/voice-tools/health-log-repository', () => ({
  fetchUserTenantIdForVoiceLog: jest.fn(async () => ({ data: { tenant_id: 'tenant-1' }, error: null })),
  fetchVitanaIndexScoreTotal: jest.fn(async () => ({ data: { score_total: 500 }, error: null })),
  upsertHealthFeatureDaily: jest.fn(async () => ({ error: null })),
  upsertManualEntryUserIntegration: jest.fn(async () => ({ error: null })),
  computeVitanaIndexForUser: jest.fn(async () => ({ data: { score_total: 510, score_hydration: 60 }, error: null })),
}));
jest.mock('../../src/services/orb-tools/health-depth-tools-repository', () => ({
  fetchTenantIdForUser: jest.fn(async () => ({ data: { tenant_id: 'tenant-1' }, error: null })),
  fetchVitanaIndexScoreTotal: jest.fn(async () => ({ data: { score_total: 500 }, error: null })),
  upsertHealthFeatureDaily: jest.fn(async () => ({ error: null })),
  upsertUserIntegrationManualEntry: jest.fn(async () => ({ error: null })),
  computeVitanaIndexForUser: jest.fn(async () => ({ data: { score_total: 505, score_mental: 70, score_nutrition: 40, score_exercise: 50 }, error: null })),
  fetchHealthFeatureValue: jest.fn(async () => ({ data: { feature_value: 1 }, error: null })),
  insertWearableSamples: jest.fn(async () => ({ error: null })),
}));
jest.mock('../../src/services/diary-health-extractor-repository', () => ({
  upsertHealthFeatureDaily: jest.fn(async () => ({ error: null })),
}));
jest.mock('../../src/services/memory/remember', () => ({ rememberFact: jest.fn(async () => ({ ok: true })) }));
jest.mock('../../src/routes/integrations-repository', () => ({
  fetchUserIntegrations: jest.fn(async () => ({ data: [], error: null })),
  upsertIntegrationConnected: jest.fn(),
  upsertIntegrationDisconnected: jest.fn(),
  fetchUserTenantId: jest.fn(async () => ({ data: { tenant_id: 'tenant-1' }, error: null })),
  upsertHealthFeatureDaily: jest.fn(async () => ({ error: null })),
  upsertManualEntryIntegrationSynced: jest.fn(async () => ({ error: null })),
  recomputeVitanaIndexForUser: jest.fn(async () => ({ data: { score_total: 501 }, error: null })),
}));
jest.mock('../../src/services/pillar-agents/orchestrator', () => ({
  runPillarAgentsForUser: jest.fn(async () => ({ agents_run: 5, agents_failed: 0, per_pillar: { hydration: { subscores: { data: 15 } } } })),
}));
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: { identity?: unknown }, _res: unknown, next: () => void) => {
    req.identity = { user_id: 'user-1' };
    next();
  },
}));
const executors = new Map<string, (args: Record<string, unknown>, ctx: { user_id: string; tenant_id: string; action_id: string }) => Promise<unknown>>();
jest.mock('../../src/services/consent-gate', () => ({
  registerActionExecutor: (type: string, fn: never) => executors.set(type, fn),
}));
jest.mock('../../src/services/action-executors-repository', () => ({
  setOfferState: jest.fn(),
  insertManualWearableWorkout: jest.fn(async () => ({ data: { id: 'wo-1' }, error: null })),
  insertCalendarEvent: jest.fn(),
}));

import * as webhookRepo from '../../src/routes/connector-webhooks-repository';
import * as voiceRepo from '../../src/services/voice-tools/health-log-repository';
import * as orbRepo from '../../src/services/orb-tools/health-depth-tools-repository';
import * as diaryRepo from '../../src/services/diary-health-extractor-repository';
import * as manualRepo from '../../src/routes/integrations-repository';
import * as actionRepo from '../../src/services/action-executors-repository';
import { logHealthSignal } from '../../src/services/voice-tools/health-log';
import { tool_log_meal, tool_log_mood, tool_log_vitals } from '../../src/services/orb-tools/health-depth-tools';
import { persistDiaryHealthFeatures } from '../../src/services/diary-health-extractor';
import { registerAllActionExecutors } from '../../src/services/action-executors';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const webhookRouter = require('../../src/routes/connector-webhooks').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const integrationsRouter = require('../../src/routes/integrations').default;

const OUTCOMES: Array<[string, () => Promise<unknown>]> = [
  ['skipped', async () => ({ ok: true, skipped: 'flag_off' })],
  ['skipped_no_consent', async () => ({ ok: true, counts: { skipped_no_consent: 2 }, dates: [], marker: 'none' })],
  ['STORE_PENDING', async () => ({ ok: false, code: 'STORE_PENDING' })],
  ['STORE_UNAVAILABLE', async () => ({ ok: false, code: 'STORE_UNAVAILABLE' })],
  ['STORE_DISABLED', async () => ({ ok: true, skipped: 'store_disabled' })],
  ['a rejection', async () => {
    throw new Error('boom');
  }],
];

/** Runs `fn` once per outcome and asserts the results are all equal. */
async function sameUnderEveryOutcome(fn: () => Promise<unknown>): Promise<unknown> {
  const results: unknown[] = [];
  for (const [, impl] of OUTCOMES) {
    mockRecord.mockImplementation(impl);
    results.push(JSON.parse(JSON.stringify(await fn())));
  }
  for (const r of results.slice(1)) expect(r).toEqual(results[0]);
  return results[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRecord.mockResolvedValue({ ok: true, skipped: 'flag_off' });
  process.env.SUPABASE_URL = 'http://localhost:54321';
  process.env.SUPABASE_SERVICE_ROLE = 'k';
});

describe('webhook daily metrics and workouts (VTID-05162)', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/connectors', webhookRouter);
  const events = [
    { topic: 'connector.wearable.sleep.recorded', user_id: 'user-1', provider: 'oura', payload: { metric_date: '2026-10-11', sleep_minutes: 437 } },
    { topic: 'connector.wearable.workout.recorded', user_id: 'user-1', provider: 'oura', payload: { external_workout_id: 'w1', started_at: '2026-10-09T23:30:00+00:00', duration_minutes: 40 } },
  ];

  it('dual-writes after each successful legacy persist, keyed to the legacy connection', async () => {
    mockHandleWebhook.mockResolvedValue({ valid: true, events });
    await request(app).post('/api/v1/connectors/webhook/oura').send({});
    expect(mockRecord).toHaveBeenCalledTimes(2);
    const [, identity, writer, values, opts] = mockRecord.mock.calls[0];
    expect({ identity, writer, opts }).toEqual({ identity: { tenant_id: 'tenant-1', user_id: 'user-1' }, writer: 'webhook_daily', opts: { legacy_user_connection_id: 'conn-1', connector_id: 'oura' } });
    expect(values).toEqual([{ code: 'sleep_session', date: '2026-10-11', value: 437 }]);
    const [, , w2, v2] = mockRecord.mock.calls[1];
    expect(w2).toBe('webhook_workout');
    expect(v2).toEqual([{ code: 'workout', date: '2026-10-09', start: '2026-10-09T23:30:00.000Z', value: 40, external_id: 'w1' }]);
  });

  it('a failed legacy persist is not dual-written', async () => {
    mockHandleWebhook.mockResolvedValue({ valid: true, events });
    (webhookRepo.upsertWearableDailyMetrics as jest.Mock).mockResolvedValueOnce({ error: { message: 'x' } });
    (webhookRepo.upsertWearableWorkout as jest.Mock).mockResolvedValueOnce({ error: { message: 'x' } });
    await request(app).post('/api/v1/connectors/webhook/oura').send({});
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('the webhook response is identical whatever the store answers', async () => {
    mockHandleWebhook.mockResolvedValue({ valid: true, events });
    const body = await sameUnderEveryOutcome(async () => {
      const res = await request(app).post('/api/v1/connectors/webhook/oura').send({});
      return { status: res.status, body: res.body };
    });
    expect(body).toEqual({ status: 200, body: { ok: true, processed: 2, skipped: 0 } });
  });
});

describe('voice logHealthSignal (VTID-05162)', () => {
  const input = { user_id: 'user-1', tenant_id: null, tool: 'log_water' as const, date: '2026-10-12', amount_ml: 500 };

  it('dual-writes after the legacy write, as the voice writer', async () => {
    await logHealthSignal(input);
    expect(mockRecord).toHaveBeenCalledWith(mockSupabase, { tenant_id: 'tenant-1', user_id: 'user-1' }, 'voice', [{ code: 'water_intake', date: '2026-10-12', value: 500 }]);
  });

  it('not after a failed legacy write; the tool result never depends on the store', async () => {
    (voiceRepo.upsertHealthFeatureDaily as jest.Mock).mockResolvedValueOnce({ error: { message: 'x' } });
    expect((await logHealthSignal(input)).ok).toBe(false);
    expect(mockRecord).not.toHaveBeenCalled();
    const r = await sameUnderEveryOutcome(() => logHealthSignal(input));
    expect(r).toMatchObject({ ok: true, summary: { feature_key: 'water_intake', value: 500, index_delta: 10 } });
  });
});

describe('ORB health tools (VTID-05162)', () => {
  const id = { user_id: 'user-1', tenant_id: 'tenant-1' } as never;

  it('log_meal is an event write, log_mood and log_vitals are replace writes; weight/BP follow their own legacy insert', async () => {
    await tool_log_meal({ description: 'salad' } as never, id, mockSupabase as never);
    expect(mockRecord).toHaveBeenLastCalledWith(mockSupabase, { tenant_id: 'tenant-1', user_id: 'user-1' }, 'orb_meal', [expect.objectContaining({ code: 'meal', value: 1 })]);
    await tool_log_mood({ mood_score: 4, date: '2026-10-12' } as never, id, mockSupabase as never);
    expect(mockRecord).toHaveBeenLastCalledWith(mockSupabase, expect.anything(), 'orb_mood', [{ code: 'mood', date: '2026-10-12', value: 4 }]);
    mockRecord.mockClear();
    await tool_log_vitals({ heart_rate: 61, weight_kg: 80, systolic: 120, date: '2026-10-12' } as never, id, mockSupabase as never);
    expect(mockRecord.mock.calls.map((c) => c[2])).toEqual(['orb_vitals', 'orb_vitals']);
    expect(mockRecord.mock.calls[1][3]).toEqual([
      { code: 'body_weight', date: '2026-10-12', value: 80 },
      { code: 'blood_pressure_systolic', date: '2026-10-12', value: 120 },
    ]);
  });

  it('nothing is dual-written when the legacy write fails, and results never depend on the store', async () => {
    (orbRepo.upsertHealthFeatureDaily as jest.Mock).mockResolvedValueOnce({ error: { message: 'x' } });
    expect((await tool_log_mood({ mood_score: 4 } as never, id, mockSupabase as never)).ok).toBe(false);
    (orbRepo.insertWearableSamples as jest.Mock).mockResolvedValueOnce({ error: { message: 'x' } });
    expect((await tool_log_vitals({ weight_kg: 80 } as never, id, mockSupabase as never)).ok).toBe(false);
    expect(mockRecord).not.toHaveBeenCalled();
    await sameUnderEveryOutcome(() => tool_log_mood({ mood_score: 4, date: '2026-10-12' } as never, id, mockSupabase as never));
    await sameUnderEveryOutcome(() => tool_log_meal({ description: 'soup', date: '2026-10-12' } as never, id, mockSupabase as never));
    await sameUnderEveryOutcome(() => tool_log_vitals({ heart_rate: 61, weight_kg: 80, date: '2026-10-12' } as never, id, mockSupabase as never));
  });
});

describe('diary persistDiaryHealthFeatures — the chokepoint of its three call sites (VTID-05162)', () => {
  const writes = [
    { feature_key: 'water_intake', feature_value: 1000, feature_unit: 'ml', pillar: 'hydration' as const, evidence: '1 L' },
    { feature_key: 'journal_entry', feature_value: 1, feature_unit: 'count', pillar: 'mental' as const, evidence: 'diary_entry' },
    { feature_key: 'meditation_minutes', feature_value: 10, feature_unit: 'min', pillar: 'mental' as const, evidence: 'meditated' },
  ];

  it('dual-writes only the writes whose legacy row landed; journal_entry has no store code', async () => {
    (diaryRepo.upsertHealthFeatureDaily as jest.Mock).mockImplementation(async (_sb: unknown, row: { feature_key: string }) =>
      row.feature_key === 'meditation_minutes' ? { error: { message: 'x' } } : { error: null });
    await persistDiaryHealthFeatures(mockSupabase as never, 'user-1', 'tenant-1', '2026-10-12', writes);
    expect(mockRecord).toHaveBeenCalledWith(mockSupabase, { tenant_id: 'tenant-1', user_id: 'user-1' }, 'diary', [{ code: 'water_intake', date: '2026-10-12', value: 1000 }]);
  });

  it('no successful legacy write, no dual-write; the result never depends on the store', async () => {
    (diaryRepo.upsertHealthFeatureDaily as jest.Mock).mockResolvedValue({ error: { message: 'x' } });
    await persistDiaryHealthFeatures(mockSupabase as never, 'user-1', 'tenant-1', '2026-10-12', writes);
    expect(mockRecord).not.toHaveBeenCalled();
    (diaryRepo.upsertHealthFeatureDaily as jest.Mock).mockResolvedValue({ error: null });
    expect(await sameUnderEveryOutcome(() => persistDiaryHealthFeatures(mockSupabase as never, 'user-1', 'tenant-1', '2026-10-12', writes))).toEqual({ written: 3, failed: 0 });
  });
});

describe('manual-log route (VTID-05162)', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/integrations', integrationsRouter);

  it('dual-writes after the legacy write as the manual writer; biomarker keys stay legacy-only', async () => {
    await request(app).post('/api/v1/integrations/manual/log').send({ pillar: 'hydration', feature_key: 'water_intake', value: 750, date: '2026-10-12' });
    expect(mockRecord).toHaveBeenCalledWith(mockSupabase, { tenant_id: 'tenant-1', user_id: 'user-1' }, 'manual', [{ code: 'water_intake', date: '2026-10-12', value: 750 }]);
    mockRecord.mockClear();
    await request(app).post('/api/v1/integrations/manual/log').send({ pillar: 'nutrition', feature_key: 'biomarker_glucose', value: 95, date: '2026-10-12' });
    expect(mockRecord).toHaveBeenCalledWith(mockSupabase, expect.anything(), 'manual', []);
  });

  it('a failed legacy write is not dual-written; the response never depends on the store', async () => {
    (manualRepo.upsertHealthFeatureDaily as jest.Mock).mockResolvedValueOnce({ error: { message: 'x' } });
    const failed = await request(app).post('/api/v1/integrations/manual/log').send({ pillar: 'hydration', feature_key: 'water_intake', value: 750 });
    expect(failed.status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
    const r = await sameUnderEveryOutcome(async () => {
      const res = await request(app).post('/api/v1/integrations/manual/log').send({ pillar: 'hydration', feature_key: 'water_intake', value: 750, date: '2026-10-12' });
      return { status: res.status, body: res.body };
    });
    expect(r).toMatchObject({ status: 200, body: { ok: true, feature_key: 'water_intake', date: '2026-10-12' } });
  });
});

describe('wearable_log_workout action (VTID-05162)', () => {
  registerAllActionExecutors();
  const exec = () => executors.get('wearable_log_workout')!;
  const ctx = { user_id: 'user-1', tenant_id: 'tenant-1', action_id: 'act-1' };

  it('dual-writes one workout record per action after the legacy insert', async () => {
    await exec()({ workout_type: 'run', duration_minutes: 30, started_at: '2026-10-12T06:00:00Z' }, ctx);
    expect(mockRecord).toHaveBeenCalledWith(
      mockSupabase,
      { tenant_id: 'tenant-1', user_id: 'user-1' },
      'manual_workout',
      [{ code: 'workout', date: '2026-10-12', start: '2026-10-12T06:00:00.000Z', value: 30, detail: { workout_type: 'run' } }],
      { call_id: 'act-1' },
    );
  });

  it('not after a failed insert; the action result never depends on the store', async () => {
    (actionRepo.insertManualWearableWorkout as jest.Mock).mockResolvedValueOnce({ data: null, error: { message: 'x' } });
    expect(await exec()({ workout_type: 'run' }, ctx)).toEqual({ ok: false, error: 'x' });
    expect(mockRecord).not.toHaveBeenCalled();
    const r = await sameUnderEveryOutcome(() => exec()({ workout_type: 'run', duration_minutes: 30, started_at: '2026-10-12T06:00:00Z' }, ctx));
    expect(r).toEqual({ ok: true, external_id: 'wo-1', result: { workout_type: 'run', duration_minutes: 30, logged_to: 'wearable_workouts (manual)' } });
  });
});
