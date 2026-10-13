/**
 * VTID-05163 (Health Hub Phase 1 / B3) — the Vitana Index dual-compute
 * (plan Changes 11–12) over an in-memory repository: the gate (flag, staging,
 * D0), one member's comparison and every diff_class, R_dev from D6a's own
 * mapper for consented providers only, the batch step (index-succeeded users
 * only, budget, failures counted, never throws, purge + daily OASIS report on
 * the first batch), the report (aggregates only — no member id, no value) and
 * the Stage 1 / Stage 2 criteria.
 */
import {
  buildDeviceReference,
  buildDualComputeReport,
  classifyMissing,
  compareMember,
  dualComputeStartDates,
  evaluateStage,
  isIndexDualComputeEnabled,
  keyClassOf,
  loadDualComputeReport,
  runIndexDualComputeForBatch,
  SELF_CODED_FEATURE_KEYS,
  type DualComputeDeps,
} from '../../src/services/health-features/index-dual-compute';
import type {
  DualComputeReportRow,
  DualComputeRow,
  FeatureKeyRow,
  IndexDualComputeRepository,
  ProjectionResult,
} from '../../src/services/health-features/index-dual-compute-repository';
import type { DailyMetricsRow, WorkoutRow } from '../../src/services/wearable-features-bridge';
import type { DailyObservationRow } from '../../src/services/health-store/reader';

const NOW = new Date('2026-10-13T03:00:00.000Z');
const TODAY = '2026-10-13';
const T = '10000000-0000-0000-0000-000000000001';
const U = 'a0000000-0000-0000-0000-00000000000a';
const D0 = '2026-10-01';
const D0S = '2026-10-05';
const ON = { VITANA_INDEX_DUAL_COMPUTE_ENABLED: 'true', HEALTH_STORE_DUAL_WRITE_DEVICE_SINCE: D0 };

const pillars = (data = 15, streak = 0) =>
  Object.fromEntries(['nutrition', 'hydration', 'exercise', 'sleep', 'mental'].map((p) => [p, { baseline: 10, completions: 0, data, streak }]));
const proj = (total: number, data = 15): ProjectionResult => ({ ok: true, score_total: total, balance_factor: 1, confidence: 0.85, subscores: pillars(data) });

interface World {
  projections: Record<string, ProjectionResult | 'error'>;
  live: { score_total: number | null; model_version: string | null; feature_inputs: Record<string, unknown> | null } | null;
  v2: FeatureKeyRow[];
  legacy: FeatureKeyRow[];
  shadow: FeatureKeyRow[];
  pending: string[];
  daily: DailyMetricsRow[];
  workouts: WorkoutRow[];
  observations: DailyObservationRow[];
  consentedProviders: Set<string>;
  selfConsent: boolean;
  upserted: DualComputeRow[];
  reportRows: DualComputeReportRow[];
  fail: Partial<Record<keyof IndexDualComputeRepository, 'error' | 'throw'>>;
  purgedBefore: string[];
}

let w: World;
const emitted: Array<{ type: string; payload?: Record<string, unknown> }> = [];

function newWorld(): World {
  return {
    projections: { 'null|null': proj(300), [`${D0}|null`]: proj(300), [`${D0}|${D0S}`]: proj(300) },
    live: { score_total: 300, model_version: 'v3-5pillar', feature_inputs: { subscores: pillars() } },
    v2: [],
    legacy: [],
    shadow: [],
    pending: [],
    daily: [],
    workouts: [],
    observations: [],
    consentedProviders: new Set(['oura']),
    selfConsent: true,
    upserted: [],
    reportRows: [],
    fail: {},
    purgedBefore: [],
  };
}

function repo(): IndexDualComputeRepository {
  const r = <T>(m: keyof IndexDualComputeRepository, fn: () => T) => {
    if (w.fail[m] === 'throw') throw new Error(`${m} threw`);
    if (w.fail[m] === 'error') return Promise.resolve({ data: null, error: { code: '57014', message: 'x' } });
    return Promise.resolve({ data: fn(), error: null });
  };
  return {
    project: (_u, d0, d0s) => {
      const p = w.projections[`${d0}|${d0s}`];
      if (p === 'error' || !p) return Promise.resolve({ data: null, error: { code: '42883', message: 'function vitana_index_project_for_user does not exist' } });
      return r('project', () => p);
    },
    fetchLiveScore: () => r('fetchLiveScore', () => w.live),
    listLegacyRows: (_u, from) => r('listLegacyRows', () => w.legacy.filter((x) => x.date >= from)),
    listShadowRows: (_u, from) => r('listShadowRows', () => w.shadow.filter((x) => x.date >= from)),
    listV2Rows: (_u, from) => r('listV2Rows', () => w.v2.filter((x) => x.date >= from)),
    listPendingDates: () => r('listPendingDates', () => w.pending.map((date) => ({ date }))),
    listDailyMetrics: (_t, _u, from) => r('listDailyMetrics', () => w.daily.filter((x) => x.metric_date >= from)),
    listWorkouts: () => r('listWorkouts', () => w.workouts),
    upsertRows: (rows) => r('upsertRows', () => {
      w.upserted.push(...rows);
      return null;
    }),
    purgeBefore: (date) => r('purgeBefore', () => {
      w.purgedBefore.push(date);
      return null;
    }),
    listReportRows: (from, to, scope) => r('listReportRows', () => w.reportRows.filter((x) => x.scope === scope && x.date >= from && x.date <= to)),
  };
}

function deps(env: NodeJS.ProcessEnv = ON, over: Partial<DualComputeDeps> = {}): DualComputeDeps {
  let t = 0;
  return {
    repo: repo(),
    readObservations: async () => ({ ok: true, rows: w.observations }),
    hasWearablesConsent: async (_i, p) => w.consentedProviders.has(p),
    hasSelfLoggedConsent: async () => w.selfConsent,
    dualWriteCounters: () => ({ 'webhook_daily:stored': 4, 'webhook_daily:STORE_UNAVAILABLE': 1, 'diary:skipped_no_consent': 2 }),
    emit: async (e) => {
      emitted.push({ type: e.type, payload: e.payload });
      return { ok: true };
    },
    env,
    now: () => NOW,
    clock: () => (t += 1),
    log: () => undefined,
    ...over,
  };
}

const obs = (date: string, code: string): DailyObservationRow => ({ date, code, value: 1, unit: 'x', sample_count: 1, updated_at: NOW.toISOString(), sources: [] });
const input = (d0s: string | null = null) => ({ tenant_id: T, user_id: U, run_date: TODAY, d0: D0, d0s });

beforeEach(() => {
  w = newWorld();
  emitted.length = 0;
});

describe('gate', () => {
  it('needs the exact flag, never on staging; D0 / D0s from the activation dates', async () => {
    expect(isIndexDualComputeEnabled({})).toBe(false);
    expect(isIndexDualComputeEnabled({ VITANA_INDEX_DUAL_COMPUTE_ENABLED: 'TRUE' })).toBe(false);
    expect(isIndexDualComputeEnabled({ ...ON, VITANA_ENV: 'staging' })).toBe(false);
    expect(isIndexDualComputeEnabled(ON)).toBe(true);
    expect(dualComputeStartDates({ HEALTH_STORE_DUAL_WRITE_SELF_LOGGED_SINCE: D0S })).toEqual({ d0: null, d0s: null });
    expect(dualComputeStartDates({ ...ON, HEALTH_STORE_DUAL_WRITE_SELF_LOGGED_SINCE: D0S })).toEqual({ d0: D0, d0s: D0S });
  });

  it('off, on staging, or without D0: a no-op that touches nothing', async () => {
    const touched = jest.fn();
    const trap = new Proxy({}, { get: () => touched }) as IndexDualComputeRepository;
    for (const env of [{}, { ...ON, VITANA_ENV: 'staging' }, { VITANA_INDEX_DUAL_COMPUTE_ENABLED: 'true' }]) {
      const r = await runIndexDualComputeForBatch(deps(env, { repo: trap }), { tenant_id: T, run_date: TODAY, users: [{ user_id: U, index_ok: true }], first_batch: true });
      expect(r.compared).toBe(0);
      expect(['disabled', 'no_d0']).toContain(r.skipped);
    }
    expect(touched).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });
});

describe('one member (Change 11 steps 1–5)', () => {
  it('equal inputs: one device row, no class, formula ok; a second scope once D0s exists', async () => {
    w.daily = [{ provider: 'oura', metric_date: '2026-10-10', steps: 8000 }];
    w.v2 = [{ date: '2026-10-10', feature_key: 'wearable_steps' }];
    const r = await compareMember(deps(), input());
    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ scope: 'device', live_total: 300, legacy_total: 300, v2_total: 300, device_rows_missing: 0, device_rows_extra: 0, diff_class: [], formula_ok: true, failure_code: null });
    expect(r.rows[0].v2_pillars?.exercise).toEqual({ data: 15, streak: 0 });
    const both = await compareMember(deps(), input(D0S));
    expect(both.rows.map((x) => x.scope)).toEqual(['device', 'all']);
  });

  it('device rows R_dev has and v2 lacks: derivation_pending (marker) / derivation_gap (observed) / store_write_failed (neither)', async () => {
    w.daily = [
      { provider: 'oura', metric_date: '2026-10-08', steps: 8000 },
      { provider: 'oura', metric_date: '2026-10-09', steps: 8000 },
      { provider: 'oura', metric_date: '2026-10-10', steps: 8000 },
    ];
    w.pending = ['2026-10-08'];
    w.observations = [obs('2026-10-09', 'steps')];
    const r = await compareMember(deps(), input());
    expect(r.rows[0].device_rows_missing).toBe(3);
    expect(r.rows[0].diff_class).toEqual(['derivation_pending', 'derivation_gap', 'store_write_failed']);
  });

  it('extra v2 rows are counted; with a marker they are derivation_pending', async () => {
    w.v2 = [{ date: '2026-10-09', feature_key: 'wearable_hrv' }];
    let r = await compareMember(deps(), input());
    expect(r.rows[0]).toMatchObject({ device_rows_extra: 1, diff_class: [] });
    w.pending = ['2026-10-09'];
    r = await compareMember(deps(), input());
    expect(r.rows[0].diff_class).toEqual(['derivation_pending']);
  });

  it('R_dev is D6a\'s own mapper over consented providers only, dates >= D0', async () => {
    w.daily = [
      { provider: 'fitbit', metric_date: '2026-10-10', steps: 8000 }, // no wearables consent
      { provider: 'oura', metric_date: '2026-09-20', steps: 8000 }, // before D0
      { provider: 'oura', metric_date: '2026-10-11', sleep_minutes: 5000 }, // implausible: D6a drops it
    ];
    w.workouts = [{ provider: 'oura', started_at: '2026-10-12T06:00:00Z' }];
    const r = await compareMember(deps(), input());
    expect(r.rows[0].device_rows_missing).toBe(1); // only the oura workout on 2026-10-12
    const ref = buildDeviceReference(w.daily, w.workouts, new Set(['oura', 'fitbit']), D0, TODAY);
    expect(Array.from(ref).sort()).toEqual(['2026-10-10|wearable_steps', '2026-10-12|wearable_workout']);
  });

  it('self-logged scope: consent_withheld, writer_not_rerouted (W-sql source, no-code key), W-manual {} counts as re-routed', async () => {
    w.legacy = [
      { date: '2026-10-10', feature_key: 'water_intake', metadata: {} }, // W-manual
      { date: '2026-10-10', feature_key: 'mood_entry', metadata: { source: 'voice_tool' } },
      { date: '2026-10-11', feature_key: 'meal_log', metadata: { source: 'health_compute_features_daily' } }, // not re-routed
      { date: '2026-10-11', feature_key: 'biomarker_glucose', metadata: {} }, // no code
      { date: '2026-10-02', feature_key: 'mood_entry', metadata: { source: 'voice_tool' } }, // before D0s
    ];
    w.v2 = [{ date: '2026-10-10', feature_key: 'mood_entry' }];
    w.selfConsent = false;
    const r = await compareMember(deps(), input(D0S));
    const all = r.rows.find((x) => x.scope === 'all')!;
    expect(all).toMatchObject({ self_rows_missing: 1, self_rows_extra: 0 });
    expect(all.diff_class).toEqual(['consent_withheld', 'writer_not_rerouted']);
    w.selfConsent = true;
    const r2 = await compareMember(deps(), input(D0S));
    expect(r2.rows.find((x) => x.scope === 'all')!.diff_class).toEqual(['writer_not_rerouted', 'store_write_failed']);
    expect(r2.rows.find((x) => x.scope === 'device')!.diff_class).toEqual([]);
  });

  it('after a `derived` cutover the legacy role for self-logged keys is the shadow (dates >= C)', async () => {
    w.legacy = [{ date: '2026-10-12', feature_key: 'water_intake', metadata: { source: 'derived_v2' } }];
    w.shadow = [{ date: '2026-10-12', feature_key: 'water_intake', metadata: { source: 'voice_tool' } }];
    const env = { ...ON, HEALTH_FEATURES_SOURCE: 'derived', HEALTH_FEATURES_CUTOVER_DATE: '2026-10-11' };
    const r = await compareMember(deps(env), input(D0S));
    expect(r.rows.find((x) => x.scope === 'all')!.self_rows_missing).toBe(1);
    w.v2 = [{ date: '2026-10-12', feature_key: 'water_intake' }];
    expect((await compareMember(deps(env), input(D0S))).rows.find((x) => x.scope === 'all')!.self_rows_missing).toBe(0);
  });

  it('formula_drift when the legacy projection differs from the live row; not_comparable for the baseline-only or a missing row', async () => {
    w.live = { score_total: 310, model_version: 'v3-5pillar', feature_inputs: { subscores: pillars() } };
    expect((await compareMember(deps(), input())).rows[0]).toMatchObject({ diff_class: ['formula_drift'], formula_ok: false });
    w.live = { score_total: 120, model_version: 'baseline-survey-v3-5pillar', feature_inputs: { source: 'baseline_survey' } };
    expect((await compareMember(deps(), input())).rows[0]).toMatchObject({ diff_class: ['not_comparable'], formula_ok: null });
    w.live = null;
    expect((await compareMember(deps(), input())).rows[0]).toMatchObject({ diff_class: ['not_comparable'], live_total: null });
  });

  it('a failure gives one failure row per scope and never throws', async () => {
    w.projections['null|null'] = 'error';
    let r = await compareMember(deps(), input(D0S));
    expect(r).toMatchObject({ ok: false, code: 'PROJECTION_FAILED' });
    expect(r.rows.map((x) => [x.scope, x.failure_code, x.v2_total])).toEqual([['device', 'PROJECTION_FAILED', null], ['all', 'PROJECTION_FAILED', null]]);
    w = newWorld();
    w.fail.listV2Rows = 'throw';
    r = await compareMember(deps(), input());
    expect(r).toMatchObject({ ok: false, code: 'THREW' });
    w = newWorld();
    r = await compareMember(deps(ON, { readObservations: async () => ({ ok: false, code: 'STORE_PENDING' }) }), input());
    expect(r).toMatchObject({ ok: false, code: 'STORE_READ_STORE_PENDING' });
  });

  it('classifyMissing and the key classes', () => {
    expect(classifyMissing({ consented: false, pending: true, observed: true })).toBe('consent_withheld');
    expect(classifyMissing({ consented: true, pending: true, observed: true })).toBe('derivation_pending');
    expect(classifyMissing({ consented: true, pending: false, observed: true })).toBe('derivation_gap');
    expect(classifyMissing({ consented: true, pending: false, observed: false })).toBe('store_write_failed');
    expect([...SELF_CODED_FEATURE_KEYS].sort()).toEqual(['meal_log', 'meditation_minutes', 'mood_entry', 'water_intake']);
    expect(keyClassOf('wearable_steps')).toBe('device');
    expect(keyClassOf('meal_log')).toBe('self_coded');
    expect(keyClassOf('biomarker_glucose')).toBe('legacy_only');
    expect(keyClassOf('nope')).toBeNull();
  });
});

describe('the batch step', () => {
  it('only users whose index stage succeeded; one row per scope; purge + daily report on the first batch', async () => {
    const r = await runIndexDualComputeForBatch(deps({ ...ON, HEALTH_STORE_DUAL_WRITE_SELF_LOGGED_SINCE: D0S }), {
      tenant_id: T,
      run_date: TODAY,
      users: [{ user_id: U, index_ok: true }, { user_id: 'b0000000-0000-0000-0000-00000000000b', index_ok: false }],
      first_batch: true,
    });
    expect(r).toEqual({ compared: 1, failed: 0, skipped_budget: 0, skipped_index: 1, report_emitted: true });
    expect(w.upserted.map((x) => [x.user_id, x.scope])).toEqual([[U, 'device'], [U, 'all']]);
    expect(w.purgedBefore).toEqual(['2026-06-15']);
    expect(emitted.map((e) => e.type)).toEqual(['health.index.dual_compute.report']);
    const payload = JSON.stringify(emitted[0].payload);
    expect(payload).not.toContain(U);
    expect(payload).not.toContain('user_id');
  });

  it('not the first batch: no purge, no report', async () => {
    await runIndexDualComputeForBatch(deps(), { tenant_id: T, run_date: TODAY, users: [{ user_id: U, index_ok: true }], first_batch: false });
    expect(w.purgedBefore).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it('stops at its budget and counts the rest skipped_budget', async () => {
    const users = Array.from({ length: 5 }, (_, i) => ({ user_id: `a000000${i}-0000-0000-0000-00000000000a`, index_ok: true }));
    let t = 0;
    const r = await runIndexDualComputeForBatch(deps({ ...ON, DUAL_COMPUTE_BATCH_BUDGET_MS: '10' }, { clock: () => (t += 4) }), { tenant_id: T, run_date: TODAY, users, first_batch: false });
    expect(r.compared + r.skipped_budget).toBe(5);
    expect(r.skipped_budget).toBeGreaterThan(0);
  });

  it('member failures and a failed upsert are counted; a throwing dependency never escapes', async () => {
    w.projections['null|null'] = 'error';
    expect(await runIndexDualComputeForBatch(deps(), { tenant_id: T, run_date: TODAY, users: [{ user_id: U, index_ok: true }], first_batch: false }))
      .toMatchObject({ compared: 0, failed: 1 });
    expect(w.upserted[0].failure_code).toBe('PROJECTION_FAILED');
    w = newWorld();
    w.fail.upsertRows = 'error';
    expect(await runIndexDualComputeForBatch(deps(), { tenant_id: T, run_date: TODAY, users: [{ user_id: U, index_ok: true }], first_batch: false }))
      .toMatchObject({ compared: 0, failed: 1 });
    w = newWorld();
    w.fail.purgeBefore = 'throw';
    const r = await runIndexDualComputeForBatch(deps(), { tenant_id: T, run_date: TODAY, users: [{ user_id: U, index_ok: true }], first_batch: true });
    expect(r).toMatchObject({ compared: 0, failed: 0 });
  });
});

// ---------------------------------------------------------------------------
// Report and stages (Change 12)
// ---------------------------------------------------------------------------

function day(date: string, user: string, over: Partial<DualComputeReportRow> = {}): DualComputeReportRow {
  return {
    user_id: user,
    date,
    scope: 'device',
    live_total: 300,
    legacy_total: 300,
    v2_total: 300,
    device_rows_missing: 0,
    device_rows_extra: 0,
    self_rows_missing: 0,
    self_rows_extra: 0,
    diff_class: [],
    formula_ok: true,
    failure_code: null,
    ...over,
  };
}
const dates = (from: string, n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));

describe('report (aggregates only)', () => {
  it('counts, percentiles, classes, mismatches, job failures, consent impact — and no member id', () => {
    const rows = [
      day('2026-10-10', 'u1'),
      day('2026-10-10', 'u2', { v2_total: 320, diff_class: ['derivation_gap'], device_rows_missing: 2 }),
      day('2026-10-10', 'u3', { v2_total: 290, diff_class: ['consent_withheld'], self_rows_missing: 1, formula_ok: false }),
      day('2026-10-10', 'u4', { failure_code: 'PROJECTION_FAILED', v2_total: null, legacy_total: null, formula_ok: null }),
    ];
    const r = buildDualComputeReport(rows, { from: '2026-10-10', to: '2026-10-10', scope: 'device' });
    expect(r).toMatchObject({
      member_days: 4,
      compared: 3,
      job_failures: 1,
      delta_total_zero_pct: 33.33,
      abs_delta_total: { p50: 10, p95: 20, max: 20 },
      formula_drift_pct: 33.33,
      consent_withheld_impact: { member_days: 1, abs_delta_points: 10 },
      row_mismatches: { device_missing: 2, device_extra: 0, self_missing: 1, self_extra: 0, member_days_device_mismatch: 1, member_days_self_mismatch: 1 },
    });
    expect(r.diff_class).toMatchObject({ derivation_gap: 1, consent_withheld: 1, store_write_failed: 0 });
    const json = JSON.stringify(r);
    for (const u of ['u1', 'u2', 'u3', 'u4']) expect(json).not.toContain(`"${u}"`);
    expect(json).not.toContain('user_id');
  });

  it('loadDualComputeReport: report + stage + B2 failure counters (stored statuses dropped); a missing table is a code', async () => {
    w.reportRows = [day('2026-10-10', 'u1')];
    const r = await loadDualComputeReport(deps(), { from: '2026-10-01', to: '2026-10-13', scope: 'device' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.member_days).toBe(1);
    expect(r.stage.stage).toBe(1);
    expect(r.dual_write_failure_counters).toEqual({ 'diary:skipped_no_consent': 2, 'webhook_daily:STORE_UNAVAILABLE': 1 });
    expect(JSON.stringify(r)).not.toContain('u1');
    w.fail.listReportRows = 'error';
    expect(await loadDualComputeReport(deps(), { from: '2026-10-01', to: '2026-10-13', scope: 'device' })).toEqual({ ok: false, code: 'DUAL_COMPUTE_STORE_UNAVAILABLE' });
  });
});

describe('Stage 1 / Stage 2 (Change 12)', () => {
  const start = '2026-09-01';
  const warm = '2026-09-08';

  it('Stage 1 is met after a 7-day warm-up with 14 consecutive green days', () => {
    const rows = dates(warm, 14).flatMap((d) => [day(d, 'u1'), day(d, 'u2')]);
    expect(evaluateStage(rows, 1, start)).toMatchObject({ met: true, warmup_end: warm, longest_green_run: 14, reasons: [] });
    expect(evaluateStage(rows.filter((r) => r.date !== dates(warm, 14)[6]), 1, start)).toMatchObject({ met: false, reasons: ['fewer_than_14_consecutive_green_days'] });
    expect(evaluateStage(dates('2026-09-02', 14).map((d) => day(d, 'u1')), 1, start).met).toBe(false); // inside the warm-up
    expect(evaluateStage(rows, 1, null)).toMatchObject({ met: false, reasons: ['no_d0'] });
  });

  it('derivation_gap, store_write_failed and job failures break a day; a pending mismatch only if it does not clear the next day', () => {
    const ds = dates(warm, 15);
    const base = ds.map((d) => day(d, 'u1'));
    const withPending = (cleared: boolean) => base.map((r, i) => (i === 3 ? { ...r, device_rows_missing: 1, diff_class: ['derivation_pending'] } : i === 4 && !cleared ? { ...r, device_rows_missing: 1, diff_class: ['derivation_pending'] } : r));
    expect(evaluateStage(withPending(true), 1, start).met).toBe(true);
    expect(evaluateStage(withPending(false), 1, start).met).toBe(false);
    for (const bad of [{ diff_class: ['derivation_gap'] }, { diff_class: ['store_write_failed'] }, { failure_code: 'THREW' }, { device_rows_extra: 1 }]) {
      const rows = base.map((r, i) => (i === 7 ? { ...r, ...bad } : r));
      expect(evaluateStage(rows, 1, start).met).toBe(false);
    }
  });

  it('formula drift above 0.5% fails; Stage 2 also needs Δtotal = 0 unless consent was withheld', () => {
    const ds = dates(warm, 14);
    const drift = ds.flatMap((d, i) => [day(d, 'u1', i === 0 ? { formula_ok: false, diff_class: ['formula_drift'] } : {}), day(d, 'u2'), day(d, 'u3')]);
    expect(evaluateStage(drift, 1, start)).toMatchObject({ met: false, reasons: ['formula_drift_above_0_5_pct'] });
    const s2 = ds.map((d) => day(d, 'u1', { scope: 'all' }));
    expect(evaluateStage(s2, 2, start).met).toBe(true);
    expect(evaluateStage(s2.map((r, i) => (i === 2 ? { ...r, v2_total: 299 } : r)), 2, start).met).toBe(false);
    expect(evaluateStage(s2.map((r, i) => (i === 2 ? { ...r, v2_total: 299, diff_class: ['consent_withheld'] } : r)), 2, start).met).toBe(true);
    expect(evaluateStage(s2, 2, null)).toMatchObject({ met: false, reasons: ['no_d0s'] });
  });
});
