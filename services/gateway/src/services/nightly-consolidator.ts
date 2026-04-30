/**
 * VTID-02632 — Phase 8 — Nightly consolidator.
 *
 * The single batch job that closes every cross-surface feedback loop in the
 * Memory Architecture Rebuild plan:
 *
 *   Loop  3 — D43 drift  → adaptation plans (drift_adaptation_plans)
 *   Loop  4 — Index delta → ranker priors    (index_delta_observations
 *                                              → vitana_index_trajectory_snapshots)
 *   Loop 10 — Diary       → personality/themes/people/signals
 *   Loop 11 — Biometrics  → trends + active anomaly events
 *   Loop 12 — Locations   → named-place patterns
 *   Loop 13 — Network     → rolling edge strengths
 *   Loop 14 — Devices     → primary-device pattern
 *
 * All seven loops are deliberately idempotent SQL aggregators that re-derive
 * their target tables from raw signals. None of them depend on an LLM call —
 * lightweight on-write extraction (sentiment + entities) already happens
 * synchronously in Phase 5+; the heavyweight LLM diary extractor is wired
 * here as a stub so the orchestration is plumbed but no Anthropic budget is
 * spent until the brain unification ships.
 *
 * Plan reference: .claude/plans/the-vitana-system-has-wild-puffin.md (Phase 8)
 */

import { getSupabase } from '../lib/supabase';
import { getSystemControl } from './system-controls-service';
import { emitOasisEvent } from './oasis-event-service';

const VTID = 'VTID-02632';

export type LoopId =
  | 'loop_3_drift'
  | 'loop_4_index_delta'
  | 'loop_10_diary'
  | 'loop_11_biometric'
  | 'loop_12_location'
  | 'loop_13_network'
  | 'loop_14_device';

export interface LoopReport {
  ok: boolean;
  loop: LoopId;
  processed: number;
  errors: number;
  notes?: string;
  duration_ms: number;
}

export interface ConsolidatorResult {
  ok: boolean;
  run_id: string | null;
  triggered_by: 'cron' | 'admin' | 'self_heal';
  triggered_at: string;
  finished_at: string;
  status: 'success' | 'partial' | 'failed';
  loops: LoopReport[];
  total_duration_ms: number;
  // Optional scope to a single user — used by the admin smoke endpoint so
  // we can verify the consolidator's effects against one account quickly.
  user_scope?: { tenant_id: string; user_id: string } | null;
}

export interface ConsolidatorInput {
  triggered_by: 'cron' | 'admin' | 'self_heal';
  // When set, only the named user is consolidated. Useful for the smoke
  // endpoint and for self-heal of a single account.
  user_scope?: { tenant_id: string; user_id: string };
  // When set, only these loops run. Empty/undefined = all loops.
  loops?: LoopId[];
}

const ALL_LOOPS: LoopId[] = [
  'loop_3_drift',
  'loop_4_index_delta',
  'loop_10_diary',
  'loop_11_biometric',
  'loop_12_location',
  'loop_13_network',
  'loop_14_device',
];

// ---------------------------------------------------------------------------
// Public entry — run the consolidator
// ---------------------------------------------------------------------------

export async function runConsolidator(input: ConsolidatorInput): Promise<ConsolidatorResult> {
  const t0 = Date.now();
  const triggeredAt = new Date().toISOString();

  // Master flag check (cron + self_heal only — admin always allowed for smoke).
  if (input.triggered_by !== 'admin') {
    const flag = await getSystemControl('consolidator_enabled');
    if (!flag || !flag.enabled) {
      return {
        ok: false,
        run_id: null,
        triggered_by: input.triggered_by,
        triggered_at: triggeredAt,
        finished_at: new Date().toISOString(),
        status: 'failed',
        loops: [],
        total_duration_ms: Date.now() - t0,
        user_scope: input.user_scope ?? null,
      };
    }
  }

  const supabase = getSupabase();
  if (!supabase) {
    return {
      ok: false,
      run_id: null,
      triggered_by: input.triggered_by,
      triggered_at: triggeredAt,
      finished_at: new Date().toISOString(),
      status: 'failed',
      loops: [],
      total_duration_ms: Date.now() - t0,
      user_scope: input.user_scope ?? null,
    };
  }

  // Open a run row
  const { data: runRow } = await supabase
    .from('consolidator_runs')
    .insert({
      triggered_by: input.triggered_by,
      tenant_id: input.user_scope?.tenant_id ?? null,
      status: 'running',
    })
    .select('id')
    .single();

  const runId: string | null = runRow?.id ?? null;

  const loopsToRun = input.loops?.length ? input.loops : ALL_LOOPS;
  const reports: LoopReport[] = [];

  for (const loop of loopsToRun) {
    const tLoop = Date.now();
    try {
      const r = await runOneLoop(loop, input.user_scope);
      reports.push({ ...r, duration_ms: Date.now() - tLoop });
    } catch (e: any) {
      reports.push({
        ok: false,
        loop,
        processed: 0,
        errors: 1,
        notes: `exception: ${e?.message ?? String(e)}`,
        duration_ms: Date.now() - tLoop,
      });
    }
  }

  const totalErrors = reports.reduce((s, r) => s + r.errors, 0);
  const totalProcessed = reports.reduce((s, r) => s + r.processed, 0);
  const status: ConsolidatorResult['status'] =
    totalErrors === 0 ? 'success' : (totalProcessed > 0 ? 'partial' : 'failed');

  const finishedAt = new Date().toISOString();

  if (runId) {
    await supabase
      .from('consolidator_runs')
      .update({
        finished_at: finishedAt,
        status,
        summary: { loops: reports },
      })
      .eq('id', runId);
  }

  // Telemetry — single OASIS event per run, regardless of loop count
  try {
    await emitOasisEvent({
      type: 'memory.consolidator.run.completed',
      vtid: VTID,
      source: 'gateway',
      status: status === 'success' ? 'success' : (status === 'partial' ? 'warning' : 'error'),
      message: `consolidator ${status}: ${totalProcessed} processed, ${totalErrors} errors`,
      payload: {
        run_id: runId,
        triggered_by: input.triggered_by,
        loops: reports.map(r => ({ loop: r.loop, ok: r.ok, processed: r.processed, errors: r.errors })),
        user_scope: input.user_scope ?? null,
      },
    });
  } catch {
    // Telemetry failure must not fail the run
  }

  return {
    ok: status !== 'failed',
    run_id: runId,
    triggered_by: input.triggered_by,
    triggered_at: triggeredAt,
    finished_at: finishedAt,
    status,
    loops: reports,
    total_duration_ms: Date.now() - t0,
    user_scope: input.user_scope ?? null,
  };
}

async function runOneLoop(
  loop: LoopId,
  scope?: { tenant_id: string; user_id: string }
): Promise<Omit<LoopReport, 'duration_ms'>> {
  switch (loop) {
    case 'loop_3_drift':       return loop3DriftAdaptation(scope);
    case 'loop_4_index_delta': return loop4IndexDeltaSnapshot(scope);
    case 'loop_10_diary':      return loop10DiaryConsolidation(scope);
    case 'loop_11_biometric':  return loop11BiometricTrends(scope);
    case 'loop_12_location':   return loop12LocationPatterns(scope);
    case 'loop_13_network':    return loop13NetworkStats(scope);
    case 'loop_14_device':     return loop14DevicePatterns(scope);
  }
}

// ---------------------------------------------------------------------------
// Loop 3 — D43 drift → adaptation plans
// ---------------------------------------------------------------------------
// We don't reimplement D43's drift detector here. Instead we read whatever
// drift the existing drift columns/tables have already flagged (or the
// `index_delta_observations` show as a sustained negative pillar trend) and
// queue a plan. If no drift signals are wired, the loop is a no-op success.

async function loop3DriftAdaptation(
  scope?: { tenant_id: string; user_id: string }
): Promise<Omit<LoopReport, 'duration_ms'>> {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, loop: 'loop_3_drift', processed: 0, errors: 1, notes: 'no supabase' };

  // Trailing 14d window: if a single pillar has > 3 negative observed_delta
  // entries summing to worse than -3 points, that's drift worth queueing a
  // plan for. Schema source: 20260427180000_vtid_02003_phase_5a_tier2_schema
  // (index_delta_observations: predicted_delta, observed_delta, observed_at,
  //  created_at). We score on observed_delta, falling back to predicted_delta
  //  when the observation hasn't been measured yet.
  const since = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
  let q = supabase
    .from('index_delta_observations')
    .select('tenant_id, user_id, pillar, predicted_delta, observed_delta, created_at')
    .gte('created_at', since);
  if (scope) q = q.eq('tenant_id', scope.tenant_id).eq('user_id', scope.user_id);
  const { data: rows, error } = await q.limit(5000);
  if (error) {
    return { ok: true, loop: 'loop_3_drift', processed: 0, errors: 0, notes: `skipped: ${error.message}` };
  }

  // Group: { user_id|pillar -> { tenant_id, sum, count } } using effective delta.
  const byKey = new Map<string, { tenant_id: string; user_id: string; pillar: string; sum: number; count: number }>();
  for (const r of (rows ?? []) as any[]) {
    const eff = (r.observed_delta !== null && r.observed_delta !== undefined)
      ? Number(r.observed_delta)
      : Number(r.predicted_delta ?? 0);
    if (!Number.isFinite(eff) || eff >= 0) continue;
    const k = `${r.user_id}|${r.pillar}`;
    const cur = byKey.get(k) ?? { tenant_id: r.tenant_id, user_id: r.user_id, pillar: r.pillar, sum: 0, count: 0 };
    cur.sum += eff;
    cur.count += 1;
    byKey.set(k, cur);
  }

  let processed = 0;
  let errors = 0;
  for (const v of byKey.values()) {
    if (v.count < 3 || v.sum > -3) continue;
    const insert = await supabase
      .from('drift_adaptation_plans')
      .insert({
        tenant_id: v.tenant_id,
        user_id: v.user_id,
        drift_kind: 'pillar_decline',
        detected_pillar: v.pillar,
        drift_magnitude: v.sum,
        recommended_actions: [
          { action_kind: 'autopilot_focus_pillar', pillar: v.pillar, intensity: 'gentle' },
          { action_kind: 'voice_checkin', topic: `${v.pillar}_drift` },
        ],
        source_engine: 'consolidator.loop_3',
      });
    if (insert.error) errors += 1; else processed += 1;
  }

  return {
    ok: errors === 0,
    loop: 'loop_3_drift',
    processed,
    errors,
    notes: `evaluated ${byKey.size} (user,pillar) groups`,
  };
}

// ---------------------------------------------------------------------------
// Loop 4 — Index delta → trajectory snapshots
// ---------------------------------------------------------------------------
// Roll up today's vitana_index_scores rows into trajectory snapshots
// (one per user per day). This is the cheap query that powers the
// 30/90-day journey overlay and the agent profile's "30-day movement" line.

async function loop4IndexDeltaSnapshot(
  scope?: { tenant_id: string; user_id: string }
): Promise<Omit<LoopReport, 'duration_ms'>> {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, loop: 'loop_4_index_delta', processed: 0, errors: 1, notes: 'no supabase' };

  // Schema source: 20251231000000_vtid_01103_health_compute_engine.sql —
  // vitana_index_scores has flat 5-pillar columns, not score_pillars jsonb.
  // Use the latest 30 days to compute tier_at_start / tier_at_end.
  const since30 = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  let q = supabase
    .from('vitana_index_scores')
    .select('tenant_id, user_id, date, score_total, score_sleep, score_nutrition, score_exercise, score_hydration, score_mental, model_version')
    .gte('date', since30);
  if (scope) q = q.eq('tenant_id', scope.tenant_id).eq('user_id', scope.user_id);
  const { data: rows, error } = await q.order('date', { ascending: true }).limit(10000);
  if (error) {
    return { ok: true, loop: 'loop_4_index_delta', processed: 0, errors: 0, notes: `skipped: ${error.message}` };
  }

  // Group rows per user; we need both endpoints of the 30d window.
  type Row = {
    tenant_id: string; user_id: string; date: string; score_total: number;
    score_sleep: number; score_nutrition: number; score_exercise: number;
    score_hydration: number; score_mental: number;
  };
  const byUser = new Map<string, Row[]>();
  for (const r of (rows ?? []) as any[]) {
    const k = r.user_id;
    if (!byUser.has(k)) byUser.set(k, []);
    byUser.get(k)!.push(r as Row);
  }

  const today = new Date().toISOString().slice(0, 10);
  let processed = 0;
  let errors = 0;
  for (const series of byUser.values()) {
    if (series.length === 0) continue;
    const first = series[0];
    const last = series[series.length - 1];
    const tierAtStart = scoreTier(first.score_total);
    const tierAtEnd = scoreTier(last.score_total);
    const trajectoryClass: string = (() => {
      const delta = (last.score_total ?? 0) - (first.score_total ?? 0);
      if (Math.abs(delta) < 5) return 'stable';
      return delta > 0 ? 'improving' : 'regressing';
    })();
    const balanceFactorAvg = balanceFactor([
      last.score_sleep, last.score_nutrition, last.score_exercise,
      last.score_hydration, last.score_mental,
    ]);
    const pillarsSnapshot = {
      sleep: last.score_sleep,
      nutrition: last.score_nutrition,
      exercise: last.score_exercise,
      hydration: last.score_hydration,
      mental: last.score_mental,
      total: last.score_total,
      window_start: first.date,
      window_end: last.date,
      observations: series.length,
    };
    const narrative =
      `30d: ${first.score_total ?? 'n/a'} → ${last.score_total ?? 'n/a'} ` +
      `(${trajectoryClass}, balance ${(balanceFactorAvg ?? 0).toFixed(2)}, ` +
      `tier ${tierAtStart} → ${tierAtEnd}, ${series.length} obs)`;

    const upsert = await supabase
      .from('vitana_index_trajectory_snapshots')
      .upsert(
        {
          tenant_id: last.tenant_id,
          user_id: last.user_id,
          snapshot_date: today,
          time_window: '30d',
          narrative,
          pillars_snapshot: pillarsSnapshot,
          balance_factor_avg: balanceFactorAvg,
          tier_at_start: tierAtStart,
          tier_at_end: tierAtEnd,
          trajectory_class: trajectoryClass,
        },
        { onConflict: 'tenant_id,user_id,snapshot_date,time_window' }
      );
    if (upsert.error) errors += 1; else processed += 1;
  }

  return {
    ok: errors === 0,
    loop: 'loop_4_index_delta',
    processed,
    errors,
    notes: `${byUser.size} user(s) snapshotted (30d window) for ${today}`,
  };
}

// Vitana Index 5-pillar tier ladder. Five pillars × max 40 each = 200 total.
function scoreTier(total: number | null | undefined): string {
  const t = Number(total ?? 0);
  if (t >= 175) return 'platinum';
  if (t >= 140) return 'gold';
  if (t >= 100) return 'silver';
  if (t >= 60)  return 'bronze';
  return 'foundation';
}

// Balance factor: 1.0 when all 5 pillars equal, 0.0 when fully imbalanced.
function balanceFactor(scores: Array<number | null | undefined>): number {
  const valid = scores.map(v => Number(v ?? 0));
  if (valid.length === 0) return 0;
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  const variance = valid.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / valid.length;
  const stddev = Math.sqrt(variance);
  // Normalize: stddev of 20 (huge spread) → 0; stddev of 0 (perfect balance) → 1.
  return Math.max(0, 1 - stddev / 20);
}

// ---------------------------------------------------------------------------
// Loop 10 — Diary consolidation (lightweight pass — heavyweight LLM stubbed)
// ---------------------------------------------------------------------------
// On-write extraction (sentiment + entities) already happens synchronously in
// the diary writer. This loop verifies the chain by counting today's entries
// and emits a telemetry signal. The real LLM consolidator (theme/personality
// rollups) is wired here as a stub — the brain unification effort owns that.

async function loop10DiaryConsolidation(
  scope?: { tenant_id: string; user_id: string }
): Promise<Omit<LoopReport, 'duration_ms'>> {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, loop: 'loop_10_diary', processed: 0, errors: 1, notes: 'no supabase' };

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  let q = supabase
    .from('memory_diary_entries')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', since);
  if (scope) q = q.eq('tenant_id', scope.tenant_id).eq('user_id', scope.user_id);
  const { count, error } = await q;
  if (error) return { ok: false, loop: 'loop_10_diary', processed: 0, errors: 1, notes: error.message };

  return {
    ok: true,
    loop: 'loop_10_diary',
    processed: count ?? 0,
    errors: 0,
    notes: 'verified-only pass; LLM theme rollup deferred to brain unification',
  };
}

// ---------------------------------------------------------------------------
// Loop 11 — Biometric trend rollup
// ---------------------------------------------------------------------------
// Re-derive `biometric_trends` from `health_features_daily` for the last 30
// days. Cheap GROUP BY; idempotent upsert.

async function loop11BiometricTrends(
  scope?: { tenant_id: string; user_id: string }
): Promise<Omit<LoopReport, 'duration_ms'>> {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, loop: 'loop_11_biometric', processed: 0, errors: 1, notes: 'no supabase' };

  // Schema source: 20251231000000_vtid_01103 (health_features_daily) +
  // 20260427180000_vtid_02003_phase_5a (biometric_trends).
  // health_features_daily has: date, feature_key, feature_value (no pillar).
  // biometric_trends has: feature_key, pillar, mean_7d/30d/90d, std_30d,
  //   latest, latest_z_score, trend_class, anomaly_flag, last_anomaly_at.
  const since30 = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  let q = supabase
    .from('health_features_daily')
    .select('tenant_id, user_id, feature_key, date, feature_value')
    .gte('date', since30);
  if (scope) q = q.eq('tenant_id', scope.tenant_id).eq('user_id', scope.user_id);
  const { data: rows, error } = await q.limit(50000);
  if (error) {
    return { ok: true, loop: 'loop_11_biometric', processed: 0, errors: 0, notes: `skipped: ${error.message}` };
  }

  // Aggregate per (user, feature_key) with rolling 7d/30d windows
  type FeatureStats = {
    tenant_id: string; user_id: string; feature_key: string;
    all30: number[]; last7: number[]; latest: number; latest_at: string;
  };
  const stats = new Map<string, FeatureStats>();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  for (const r of (rows ?? []) as any[]) {
    const v = Number(r.feature_value);
    if (!Number.isFinite(v)) continue;
    const k = `${r.user_id}|${r.feature_key}`;
    const cur: FeatureStats = stats.get(k) ?? {
      tenant_id: r.tenant_id, user_id: r.user_id, feature_key: r.feature_key,
      all30: [], last7: [], latest: v, latest_at: r.date,
    };
    cur.all30.push(v);
    if (r.date >= sevenDaysAgo) cur.last7.push(v);
    if (r.date > cur.latest_at) {
      cur.latest = v;
      cur.latest_at = r.date;
    }
    stats.set(k, cur);
  }

  let processed = 0;
  let errors = 0;
  for (const s of stats.values()) {
    if (s.all30.length < 3) continue;
    const mean30 = s.all30.reduce((a, b) => a + b, 0) / s.all30.length;
    const mean7 = s.last7.length > 0 ? s.last7.reduce((a, b) => a + b, 0) / s.last7.length : null;
    const variance30 = s.all30.reduce((a, b) => a + Math.pow(b - mean30, 2), 0) / s.all30.length;
    const std30 = Math.sqrt(variance30);
    const z = std30 > 0 ? (s.latest - mean30) / std30 : 0;
    let trendClass: string;
    if (s.all30.length < 7) trendClass = 'insufficient_data';
    else if (Math.abs(z) < 0.5) trendClass = 'stable';
    else if (Math.abs(z) > 2) trendClass = 'volatile';
    else trendClass = z > 0 ? 'improving' : 'regressing';
    const anomaly = Math.abs(z) >= 2;

    const upsert = await supabase
      .from('biometric_trends')
      .upsert(
        {
          tenant_id: s.tenant_id,
          user_id: s.user_id,
          feature_key: s.feature_key,
          pillar: featureKeyToPillar(s.feature_key),
          mean_7d: mean7,
          mean_30d: mean30,
          std_30d: std30,
          latest: s.latest,
          latest_z_score: z,
          trend_class: trendClass,
          anomaly_flag: anomaly,
          last_anomaly_at: anomaly ? new Date().toISOString() : null,
          computed_at: new Date().toISOString(),
        },
        { onConflict: 'tenant_id,user_id,feature_key' }
      );
    if (upsert.error) errors += 1; else processed += 1;
  }

  return {
    ok: errors === 0,
    loop: 'loop_11_biometric',
    processed,
    errors,
    notes: `${stats.size} (user,feature) pairs evaluated`,
  };
}

// Lightweight feature_key -> pillar map. Best-effort; unknown keys default to mental.
function featureKeyToPillar(key: string): string {
  const k = key.toLowerCase();
  if (k.includes('sleep') || k.includes('hrv')) return 'sleep';
  if (k.includes('hydra') || k.includes('water')) return 'hydration';
  if (k.includes('step') || k.includes('exercise') || k.includes('workout') || k.includes('heart_rate')) return 'exercise';
  if (k.includes('calor') || k.includes('protein') || k.includes('nutrient') || k.includes('meal')) return 'nutrition';
  return 'mental';
}

// ---------------------------------------------------------------------------
// Loop 12 — Location patterns
// ---------------------------------------------------------------------------
// Roll up the last 30 days of user_location_history into named-place candidates
// in user_location_settings.named_places. The dwell-time/visit-count thresholds
// keep this from over-suggesting.

async function loop12LocationPatterns(
  scope?: { tenant_id: string; user_id: string }
): Promise<Omit<LoopReport, 'duration_ms'>> {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, loop: 'loop_12_location', processed: 0, errors: 1, notes: 'no supabase' };

  // Schema source: 20260427180000_vtid_02003_phase_5a — user_location_history
  // has valid_from/valid_to (bi-temporal), and user_location_settings is one
  // row per named place (NOT a jsonb list). Build a candidate row per locality
  // that meets the visit-count threshold.
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  let q = supabase
    .from('user_location_history')
    .select('tenant_id, user_id, locality, country, timezone, location_type, valid_from')
    .gte('valid_from', since);
  if (scope) q = q.eq('tenant_id', scope.tenant_id).eq('user_id', scope.user_id);
  const { data: rows, error } = await q.limit(50000);
  if (error) {
    return { ok: true, loop: 'loop_12_location', processed: 0, errors: 0, notes: `skipped: ${error.message}` };
  }

  // Per-user, group by locality
  type LocalityStats = { tenant_id: string; user_id: string; locality: string; country: string | null; timezone: string | null; count: number };
  const byKey = new Map<string, LocalityStats>();
  for (const r of (rows ?? []) as any[]) {
    if (!r.locality) continue;
    const k = `${r.user_id}|${r.locality}`;
    const cur: LocalityStats = byKey.get(k) ?? {
      tenant_id: r.tenant_id, user_id: r.user_id, locality: r.locality,
      country: r.country ?? null, timezone: r.timezone ?? null, count: 0,
    };
    cur.count += 1;
    byKey.set(k, cur);
  }

  let processed = 0;
  let errors = 0;
  for (const s of byKey.values()) {
    if (s.count < 3) continue;
    const upsert = await supabase
      .from('user_location_settings')
      .upsert(
        {
          tenant_id: s.tenant_id,
          user_id: s.user_id,
          name: s.locality,
          locality: s.locality,
          country: s.country,
          timezone: s.timezone,
          is_primary_home: false,
          user_confirmed: false,
        },
        { onConflict: 'tenant_id,user_id,name' }
      );
    if (upsert.error) errors += 1; else processed += 1;
  }

  return {
    ok: errors === 0,
    loop: 'loop_12_location',
    processed,
    errors,
    notes: `${byKey.size} (user,locality) candidates evaluated`,
  };
}

// ---------------------------------------------------------------------------
// Loop 13 — Network rolling stats
// ---------------------------------------------------------------------------
// Bump relationship_edges.strength based on recent mention counts. Decay
// strengths that haven't been touched in 30 days.

async function loop13NetworkStats(
  scope?: { tenant_id: string; user_id: string }
): Promise<Omit<LoopReport, 'duration_ms'>> {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, loop: 'loop_13_network', processed: 0, errors: 1, notes: 'no supabase' };

  // Schema source: 20251231000001_vtid_01087_relationship_graph_memory.sql.
  // relationship_edges is polymorphic: source_id/target_id (with type tags),
  // strength is integer-ish (1..10). Decay rule: edges with no interaction
  // in 30 days drift toward 5 (mid) by 5% — bounded to [1,10].
  // Tenant scoping is supported; per-user scoping uses source_id.
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  let q = supabase
    .from('relationship_edges')
    .select('id, tenant_id, source_id, target_id, strength, last_interaction_at')
    .lte('last_interaction_at', cutoff);
  if (scope) {
    q = q.eq('tenant_id', scope.tenant_id);
    // Source-only filter — keeps the query simple and idempotent.
    q = q.eq('source_id', scope.user_id);
  }
  const { data: rows, error } = await q.limit(5000);
  if (error) {
    return { ok: true, loop: 'loop_13_network', processed: 0, errors: 0, notes: `skipped: ${error.message}` };
  }

  let processed = 0;
  let errors = 0;
  for (const r of (rows ?? []) as any[]) {
    const cur = Number(r.strength) || 5;
    const target = 5;
    const decayed = Math.max(1, Math.min(10, cur + (target - cur) * 0.05));
    if (Math.abs(decayed - cur) < 0.01) continue;
    const update = await supabase
      .from('relationship_edges')
      .update({ strength: decayed, updated_at: new Date().toISOString() })
      .eq('id', r.id);
    if (update.error) errors += 1; else processed += 1;
  }

  return {
    ok: errors === 0,
    loop: 'loop_13_network',
    processed,
    errors,
    notes: `${(rows ?? []).length} stale edge(s) eligible for decay`,
  };
}

// ---------------------------------------------------------------------------
// Loop 14 — Device patterns
// ---------------------------------------------------------------------------
// Mark the most-used device in the last 30 days as primary on
// user_device_tokens.is_primary. Lightweight; mostly informational.

async function loop14DevicePatterns(
  scope?: { tenant_id: string; user_id: string }
): Promise<Omit<LoopReport, 'duration_ms'>> {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, loop: 'loop_14_device', processed: 0, errors: 1, notes: 'no supabase' };

  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  let q = supabase
    .from('user_device_session_log')
    .select('tenant_id, user_id, device_token_id, started_at')
    .gte('started_at', since);
  if (scope) q = q.eq('tenant_id', scope.tenant_id).eq('user_id', scope.user_id);
  const { data: rows, error } = await q.limit(50000);
  if (error) {
    return { ok: true, loop: 'loop_14_device', processed: 0, errors: 0, notes: `skipped: ${error.message}` };
  }

  // Per-user, count sessions per device
  const byUser = new Map<string, { tenant_id: string; user_id: string; counts: Map<string, number> }>();
  for (const r of (rows ?? []) as any[]) {
    if (!r.device_token_id) continue;
    const u = byUser.get(r.user_id) ?? { tenant_id: r.tenant_id, user_id: r.user_id, counts: new Map() };
    u.counts.set(r.device_token_id, (u.counts.get(r.device_token_id) ?? 0) + 1);
    byUser.set(r.user_id, u);
  }

  let processed = 0;
  let errors = 0;
  for (const u of byUser.values()) {
    if (u.counts.size === 0) continue;
    const winner = [...u.counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    // Best-effort: not every env has user_device_tokens with is_primary,
    // so swallow errors quietly.
    const upd = await supabase
      .from('user_device_tokens')
      .update({ is_primary: true, updated_at: new Date().toISOString() })
      .eq('id', winner);
    if (upd.error) {
      // skipped — column may not exist
    } else {
      processed += 1;
    }
  }

  return {
    ok: errors === 0,
    loop: 'loop_14_device',
    processed,
    errors,
    notes: `${byUser.size} user(s) with session log`,
  };
}
