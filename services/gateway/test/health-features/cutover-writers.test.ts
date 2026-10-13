/**
 * VTID-05163 (Health Hub Phase 1 / B3) — the cutover switch at the call sites
 * (plan Change 13), and the proof that the Index members see does not change
 * while the switch is off.
 *
 *   OFF (unset; `derived` on staging; `derived` without a cutover date; a mode
 *   whose writer's dual-write flag is off): every writer makes exactly its
 *   legacy health_features_daily write, nothing goes to the shadow, the D6a
 *   bridge writes health_features_daily as before, W-sql runs, and
 *   recordToHealthStore is called with cutover:false (B2's non-fatal path).
 *   `derived_device`: only the webhook writers and wearable_log_workout are cut
 *   over; the bridge goes to the shadow; the webhook recomputes the Index once
 *   per member; a failure is a 503. `derived`: every re-routed writer writes
 *   the shadow instead of health_features_daily for coded keys and dates >= C,
 *   biomarker/journal keys stay legacy, a failure is the call's error, W-sql is
 *   skipped.
 */
import express from 'express';
import request from 'supertest';
import { createMemoryFeaturesRepo, type MemoryFeaturesRepo } from './memory-features-repo';

const mockRecord = jest.fn();
jest.mock('../../src/services/health-features/record-to-health-store', () => ({
  recordToHealthStore: (...args: unknown[]) => mockRecord(...args),
}));
let mockRepo: MemoryFeaturesRepo;
jest.mock('../../src/services/health-features/health-features-repository', () => {
  const actual = jest.requireActual('../../src/services/health-features/health-features-repository');
  return { ...actual, healthFeaturesRepository: () => mockRepo };
});
const mockDeriveForRecompute = jest.fn();
jest.mock('../../src/services/health-features/recompute-features-step', () => ({
  deriveFeaturesForRecompute: (...a: unknown[]) => mockDeriveForRecompute(...a),
}));

const mockSupabase = { from: jest.fn(), rpc: jest.fn() };
jest.mock('../../src/lib/supabase', () => ({ getSupabase: jest.fn(() => mockSupabase) }));
jest.mock('../../src/lib/supabase-user', () => ({ createUserSupabaseClient: jest.fn(() => mockSupabase) }));
jest.mock('../../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));
jest.mock('../../src/services/health-sources/legacy-mirror', () => ({
  dualWriteUserIntegration: jest.fn(() => null),
  dualWriteUserConnections: jest.fn(() => null),
}));
jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => mockSupabase) }));

const mockBridge = jest.fn();
jest.mock('../../src/services/wearable-features-bridge', () => {
  const actual = jest.requireActual('../../src/services/wearable-features-bridge');
  return { ...actual, bridgeWearableDays: (...a: unknown[]) => mockBridge(...a) };
});
jest.mock('../../src/services/wearable-features-bridge-repository', () => ({
  computeVitanaIndexForUser: jest.fn(async () => ({ data: { score_total: 500 }, error: null })),
}));

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
  fetchHealthFeatureValue: jest.fn(async () => ({ data: { feature_value: 4 }, error: null })),
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
  runPillarAgentsForUser: jest.fn(async () => ({ agents_run: 5, agents_failed: 0, per_pillar: {} })),
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
jest.mock('../../src/routes/health-repository', () => ({
  rpcHealthComputeFeaturesDaily: jest.fn(async () => ({ data: { ok: true, upserted_count: 3, tenant_id: 't', user_id: 'u' }, error: null })),
  rpcHealthComputeVitanaIndex: jest.fn(async () => ({ data: { ok: true, score_total: 500 }, error: null })),
  rpcHealthGenerateRecommendations: jest.fn(async () => ({ data: { ok: true, created_count: 0 }, error: null })),
}));

import * as voiceRepo from '../../src/services/voice-tools/health-log-repository';
import * as orbRepo from '../../src/services/orb-tools/health-depth-tools-repository';
import * as diaryRepo from '../../src/services/diary-health-extractor-repository';
import * as manualRepo from '../../src/routes/integrations-repository';
import * as bridgeRepo from '../../src/services/wearable-features-bridge-repository';
import * as healthRepo from '../../src/routes/health-repository';
import { logHealthSignal } from '../../src/services/voice-tools/health-log';
import { tool_log_meal, tool_log_mood } from '../../src/services/orb-tools/health-depth-tools';
import { persistDiaryHealthFeatures } from '../../src/services/diary-health-extractor';
import { registerAllActionExecutors } from '../../src/services/action-executors';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const webhookRouter = require('../../src/routes/connector-webhooks').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const integrationsRouter = require('../../src/routes/integrations').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const healthRouter = require('../../src/routes/health').default;

const C = '2026-10-10';
const DAY = '2026-10-12';
const SAVED = { ...process.env };
const ENV_KEYS = ['HEALTH_FEATURES_SOURCE', 'HEALTH_FEATURES_CUTOVER_DATE', 'HEALTH_STORE_DUAL_WRITE_DEVICE', 'HEALTH_STORE_DUAL_WRITE_SELF_LOGGED', 'VITANA_ENV', 'WEARABLE_FEATURE_BRIDGE_ENABLED'];
function setEnv(env: Record<string, string>) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
}
const DERIVED = { HEALTH_FEATURES_SOURCE: 'derived', HEALTH_FEATURES_CUTOVER_DATE: C, HEALTH_STORE_DUAL_WRITE_DEVICE: 'true', HEALTH_STORE_DUAL_WRITE_SELF_LOGGED: 'true' };
const DERIVED_DEVICE = { HEALTH_FEATURES_SOURCE: 'derived_device', HEALTH_FEATURES_CUTOVER_DATE: C, HEALTH_STORE_DUAL_WRITE_DEVICE: 'true', HEALTH_STORE_DUAL_WRITE_SELF_LOGGED: 'true' };
/** Every way the switch is OFF — the Index members see must be exactly today's. */
const OFF: Array<[string, Record<string, string>]> = [
  ['unset', {}],
  ['dual-write flags on, switch unset', { HEALTH_STORE_DUAL_WRITE_DEVICE: 'true', HEALTH_STORE_DUAL_WRITE_SELF_LOGGED: 'true', WEARABLE_FEATURE_BRIDGE_ENABLED: 'true' }],
  ['derived on staging', { ...DERIVED, VITANA_ENV: 'staging' }],
  ['derived without a cutover date', { ...DERIVED, HEALTH_FEATURES_CUTOVER_DATE: '' }],
  ['an unknown value', { ...DERIVED, HEALTH_FEATURES_SOURCE: 'DERIVED' }],
  ['derived with both dual-write flags off', { HEALTH_FEATURES_SOURCE: 'derived', HEALTH_FEATURES_CUTOVER_DATE: C }],
];

const app = express();
app.use(express.json());
app.use('/api/v1/connectors', webhookRouter);
app.use('/api/v1/integrations', integrationsRouter);
app.use('/api/v1/health', healthRouter);

beforeAll(() => registerAllActionExecutors());
afterAll(() => {
  process.env = SAVED;
});
beforeEach(() => {
  jest.clearAllMocks();
  mockRepo = createMemoryFeaturesRepo();
  mockRecord.mockResolvedValue({ ok: true, counts: { stored: 1 }, dates: [DAY], marker: 'written' });
  mockBridge.mockResolvedValue({ ok: true, features_written: 1, days: 1, index_recomputed: true });
  mockDeriveForRecompute.mockResolvedValue({ data: { ok: true, upserted_count: 2, tenant_id: 't', user_id: 'u', source: 'derived_v2' }, error: null });
  process.env.SUPABASE_URL = 'http://localhost:54321';
  process.env.SUPABASE_SERVICE_ROLE = 'k';
});

const voiceInput = { tool: 'log_water' as const, user_id: 'user-1', tenant_id: 'tenant-1', date: DAY, amount_ml: 500 };
const webhookEvents = [
  { topic: 'connector.wearable.sleep.recorded', user_id: 'user-1', provider: 'oura', payload: { metric_date: DAY, sleep_minutes: 437 } },
  { topic: 'connector.wearable.workout.recorded', user_id: 'user-1', provider: 'oura', payload: { external_workout_id: 'w1', started_at: `${DAY}T06:00:00Z`, duration_minutes: 40 } },
];
const cutoverArg = (call: unknown[]) => (call[4] as { cutover?: boolean } | undefined)?.cutover;

describe.each(OFF)('switch OFF (%s): every writer is exactly as today', (_name, env) => {
  beforeEach(() => setEnv(env));

  it('voice / ORB / diary / manual write health_features_daily, never the shadow; cutover:false', async () => {
    const voice = await logHealthSignal(voiceInput);
    expect(voice.ok).toBe(true);
    expect(voiceRepo.upsertHealthFeatureDaily).toHaveBeenCalledWith(mockSupabase, expect.objectContaining({ feature_key: 'water_intake', feature_value: 500, date: DAY }));
    await tool_log_meal({ description: 'x', date: DAY } as never, { user_id: 'user-1', tenant_id: 'tenant-1' } as never, mockSupabase as never);
    expect(orbRepo.fetchHealthFeatureValue).toHaveBeenCalled();
    expect(orbRepo.upsertHealthFeatureDaily).toHaveBeenCalledWith(mockSupabase, expect.objectContaining({ feature_key: 'meal_log', feature_value: 5 }));
    const diary = await persistDiaryHealthFeatures(mockSupabase as never, 'user-1', 'tenant-1', DAY, [
      { feature_key: 'water_intake', feature_value: 1000, feature_unit: 'ml', pillar: 'hydration', evidence: 'x' },
      { feature_key: 'journal_entry', feature_value: 1, feature_unit: 'count', pillar: 'mental', evidence: 'x' },
    ]);
    expect(diary).toEqual({ written: 2, failed: 0 });
    expect(diaryRepo.upsertHealthFeatureDaily).toHaveBeenCalledTimes(2);
    const manual = await request(app).post('/api/v1/integrations/manual/log').send({ pillar: 'hydration', feature_key: 'water_intake', value: 750, date: DAY });
    expect(manual.status).toBe(200);
    expect(manualRepo.upsertHealthFeatureDaily).toHaveBeenCalledTimes(1);
    expect(mockRepo.shadow.size).toBe(0);
    expect(mockRepo.calls).toEqual([]);
    for (const c of mockRecord.mock.calls) expect(cutoverArg(c)).toBe(false);
  });

  it('the result never depends on the store: a failing store changes nothing', async () => {
    mockRecord.mockResolvedValue({ ok: false, code: 'STORE_UNAVAILABLE' });
    expect((await logHealthSignal(voiceInput)).ok).toBe(true);
    expect((await tool_log_mood({ mood_score: 4, date: DAY } as never, { user_id: 'user-1', tenant_id: 'tenant-1' } as never, mockSupabase as never)).ok).toBe(true);
    const manual = await request(app).post('/api/v1/integrations/manual/log').send({ pillar: 'hydration', feature_key: 'water_intake', value: 750, date: DAY });
    expect(manual.status).toBe(200);
    expect((await executors.get('wearable_log_workout')!({ workout_type: 'run', started_at: `${DAY}T06:00:00Z` }, { user_id: 'user-1', tenant_id: 'tenant-1', action_id: 'a1' }) as { ok: boolean }).ok).toBe(true);
    mockHandleWebhook.mockResolvedValue({ valid: true, events: webhookEvents });
    expect((await request(app).post('/api/v1/connectors/webhook/oura').send({})).status).toBe(200);
  });

  it('the webhook: the bridge writes health_features_daily (no shadow option), no extra Index recompute', async () => {
    mockHandleWebhook.mockResolvedValue({ valid: true, events: webhookEvents });
    const res = await request(app).post('/api/v1/connectors/webhook/oura').send({});
    expect(res.body).toEqual({ ok: true, processed: 2, skipped: 0 });
    if (process.env.WEARABLE_FEATURE_BRIDGE_ENABLED === 'true' && process.env.VITANA_ENV !== 'staging') {
      expect(mockBridge).toHaveBeenCalledWith(mockSupabase, expect.objectContaining({ userId: 'user-1' }), {});
    }
    expect(bridgeRepo.computeVitanaIndexForUser).not.toHaveBeenCalled();
    for (const c of mockRecord.mock.calls) expect(cutoverArg(c)).toBe(false);
  });

  it('POST /recompute/daily runs W-sql', async () => {
    const res = await request(app).post('/api/v1/health/recompute/daily').set('Authorization', 'Bearer t').send({ date: DAY });
    expect(res.status).toBe(200);
    expect(healthRepo.rpcHealthComputeFeaturesDaily).toHaveBeenCalledWith(mockSupabase, DAY);
    expect(mockDeriveForRecompute).not.toHaveBeenCalled();
  });
});

describe('derived (after Stage 2): every re-routed writer', () => {
  beforeEach(() => setEnv(DERIVED));

  it('voice: the row goes to the shadow, the store write is synchronous and fatal; the Index recompute still runs', async () => {
    const ok = await logHealthSignal(voiceInput);
    expect(ok.ok).toBe(true);
    expect(voiceRepo.upsertHealthFeatureDaily).not.toHaveBeenCalled();
    expect(Array.from(mockRepo.shadow.values())).toEqual([expect.objectContaining({ feature_key: 'water_intake', feature_value: 500, metadata: { source: 'voice_tool' } })]);
    expect(cutoverArg(mockRecord.mock.calls[0])).toBe(true);
    expect(voiceRepo.computeVitanaIndexForUser).toHaveBeenCalled();
    mockRecord.mockResolvedValueOnce({ ok: false, code: 'DERIVATION_FEATURES_STORE_UNAVAILABLE' });
    expect(await logHealthSignal(voiceInput)).toEqual({ ok: false, error: 'health_features_derivation_failed: DERIVATION_FEATURES_STORE_UNAVAILABLE' });
  });

  it('a date before C stays legacy', async () => {
    await logHealthSignal({ ...voiceInput, date: '2026-10-09' });
    expect(voiceRepo.upsertHealthFeatureDaily).toHaveBeenCalled();
    expect(mockRepo.shadow.size).toBe(0);
    expect(cutoverArg(mockRecord.mock.calls[0])).toBe(false);
  });

  it('ORB log_meal counts from the shadow and writes the shadow; a failure is the tool\'s error', async () => {
    await mockRepo.upsertLegacyShadow([{ tenant_id: 'tenant-1', user_id: 'user-1', date: DAY, feature_key: 'meal_log', feature_value: 2 }]);
    const r = await tool_log_meal({ description: 'x', date: DAY } as never, { user_id: 'user-1', tenant_id: 'tenant-1' } as never, mockSupabase as never);
    expect(r.ok).toBe(true);
    expect(orbRepo.fetchHealthFeatureValue).not.toHaveBeenCalled();
    expect(orbRepo.upsertHealthFeatureDaily).not.toHaveBeenCalled();
    expect(mockRepo.shadow.get(`tenant-1|user-1|${DAY}|meal_log`)?.feature_value).toBe(3);
    mockRecord.mockResolvedValueOnce({ ok: false, code: 'IMPLAUSIBLE' });
    const bad = await tool_log_mood({ mood_score: 4, date: DAY } as never, { user_id: 'user-1', tenant_id: 'tenant-1' } as never, mockSupabase as never);
    expect(bad.ok).toBe(false);
  });

  it('diary: coded keys to the shadow, journal_entry stays legacy; a failure is returned as error_code', async () => {
    const writes = [
      { feature_key: 'water_intake', feature_value: 1000, feature_unit: 'ml', pillar: 'hydration' as const, evidence: 'x' },
      { feature_key: 'journal_entry', feature_value: 1, feature_unit: 'count', pillar: 'mental' as const, evidence: 'x' },
    ];
    expect(await persistDiaryHealthFeatures(mockSupabase as never, 'user-1', 'tenant-1', DAY, writes as never)).toEqual({ written: 2, failed: 0 });
    expect(diaryRepo.upsertHealthFeatureDaily).toHaveBeenCalledTimes(1);
    expect(diaryRepo.upsertHealthFeatureDaily).toHaveBeenCalledWith(mockSupabase, expect.objectContaining({ feature_key: 'journal_entry' }));
    expect(Array.from(mockRepo.shadow.keys())).toEqual([`tenant-1|user-1|${DAY}|water_intake`]);
    mockRecord.mockResolvedValueOnce({ ok: false, code: 'STORE_DISABLED' });
    expect(await persistDiaryHealthFeatures(mockSupabase as never, 'user-1', 'tenant-1', DAY, writes as never))
      .toEqual({ written: 1, failed: 1, error_code: 'health_features_derivation_failed:STORE_DISABLED' });
  });

  it('manual log: coded key to the shadow, 503 on a failure; a biomarker stays legacy', async () => {
    const ok = await request(app).post('/api/v1/integrations/manual/log').send({ pillar: 'hydration', feature_key: 'water_intake', value: 750, date: DAY });
    expect(ok.status).toBe(200);
    expect(manualRepo.upsertHealthFeatureDaily).not.toHaveBeenCalled();
    mockRecord.mockResolvedValueOnce({ ok: false, code: 'STORE_UNAVAILABLE' });
    const bad = await request(app).post('/api/v1/integrations/manual/log').send({ pillar: 'hydration', feature_key: 'water_intake', value: 750, date: DAY });
    expect(bad.status).toBe(503);
    expect(bad.body).toEqual({ ok: false, error: 'HEALTH_FEATURES_DERIVATION_FAILED', code: 'STORE_UNAVAILABLE' });
    const bio = await request(app).post('/api/v1/integrations/manual/log').send({ pillar: 'nutrition', feature_key: 'biomarker_glucose', value: 95, date: DAY });
    expect(bio.status).toBe(200);
    expect(manualRepo.upsertHealthFeatureDaily).toHaveBeenCalledWith(mockSupabase, expect.objectContaining({ feature_key: 'biomarker_glucose' }));
  });

  it('POST /recompute/daily skips W-sql and derives the member-day instead', async () => {
    const res = await request(app).post('/api/v1/health/recompute/daily').set('Authorization', 'Bearer t').send({ date: DAY });
    expect(res.status).toBe(200);
    expect(healthRepo.rpcHealthComputeFeaturesDaily).not.toHaveBeenCalled();
    expect(mockDeriveForRecompute).toHaveBeenCalledWith(mockSupabase, DAY);
    mockDeriveForRecompute.mockResolvedValueOnce({ data: { ok: false, error: 'FEATURES_DERIVATION_FAILED', message: 'NO_TENANT' }, error: null });
    const bad = await request(app).post('/api/v1/health/recompute/daily').set('Authorization', 'Bearer t').send({ date: DAY });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('FEATURES_DERIVATION_FAILED');
  });
});

describe('derived_device (after Stage 1): device writers only', () => {
  beforeEach(() => setEnv({ ...DERIVED_DEVICE, WEARABLE_FEATURE_BRIDGE_ENABLED: 'true' }));

  it('self-logged writers stay legacy', async () => {
    await logHealthSignal(voiceInput);
    expect(voiceRepo.upsertHealthFeatureDaily).toHaveBeenCalled();
    expect(cutoverArg(mockRecord.mock.calls[0])).toBe(false);
    const res = await request(app).post('/api/v1/health/recompute/daily').set('Authorization', 'Bearer t').send({ date: DAY });
    expect(res.status).toBe(200);
    expect(healthRepo.rpcHealthComputeFeaturesDaily).toHaveBeenCalled(); // W-sql skipped only in `derived`
  });

  it('webhook: synchronous store write, the bridge goes to the shadow, one Index recompute per member; a failure is a 503', async () => {
    mockHandleWebhook.mockResolvedValue({ valid: true, events: webhookEvents });
    const ok = await request(app).post('/api/v1/connectors/webhook/oura').send({});
    expect(ok.body).toEqual({ ok: true, processed: 2, skipped: 0 });
    expect(mockRecord.mock.calls.map(cutoverArg)).toEqual([true, true]);
    expect(mockBridge).toHaveBeenCalledWith(mockSupabase, expect.objectContaining({ userId: 'user-1' }), { shadow: expect.any(Object) });
    expect(bridgeRepo.computeVitanaIndexForUser).toHaveBeenCalledTimes(1);
    mockRecord.mockResolvedValueOnce({ ok: false, code: 'DERIVATION_FEATURES_STORE_UNAVAILABLE' });
    const bad = await request(app).post('/api/v1/connectors/webhook/oura').send({});
    expect(bad.status).toBe(503);
    expect(bad.body).toMatchObject({ ok: false, error: 'HEALTH_FEATURES_DERIVATION_FAILED', code: 'DERIVATION_FEATURES_STORE_UNAVAILABLE' });
  });

  it('wearable_log_workout: a store / derivation failure is the action\'s error', async () => {
    const exec = executors.get('wearable_log_workout')!;
    const ctx = { user_id: 'user-1', tenant_id: 'tenant-1', action_id: 'a1' };
    expect(await exec({ workout_type: 'run', started_at: `${DAY}T06:00:00Z` }, ctx)).toMatchObject({ ok: true });
    expect(cutoverArg(mockRecord.mock.calls[0])).toBe(true);
    mockRecord.mockResolvedValueOnce({ ok: false, code: 'STORE_DISABLED' });
    expect(await exec({ workout_type: 'run', started_at: `${DAY}T06:00:00Z` }, ctx)).toEqual({ ok: false, error: 'health_features_derivation_failed: STORE_DISABLED' });
  });
});
