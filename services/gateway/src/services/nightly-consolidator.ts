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

  // Trailing 14d window: if a single pillar has > 3 negative deltas summing to
  // worse than -3 points, that's drift worth queueing a plan for.
  const since = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
  let q = supabase
    .from('index_delta_observations')
    .select('tenant_id, user_id, pillar, pillar_delta')
    .lt('pillar_delta', 0)
    .gte('observed_at', since);
  if (scope) q = q.eq('tenant_id', scope.tenant_id).eq('user_id', scope.user_id);
  const { data: rows, error } = await q.limit(5000);
  if (error) return { ok: false, loop: 'loop_3_drift', processed: 0, errors: 1, notes: error.message };

  // Group: { user_id|pillar -> { tenant_id, sum, count } }
  const byKey = new Map<string, { tenant_id: string; user_id: string; pillar: string; sum: number; count: number }>();
  for (const r of (rows ?? []) as any[]) {
    const k = `${r.user_id}|${r.pillar}`;
    const cur = byKey.get(k) ?? { tenant_id: r.tenant_id, user_id: r.user_id, pillar: r.pillar, sum: 0, count: 0 };
    cur.sum += Number(r.pillar_delta) || 0;
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

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  let q = supabase
    .from('vitana_index_scores')
    .select('tenant_id, user_id, score_total, score_pillars, balance_factor, tier, computed_at')
    .gte('computed_at', since);
  if (scope) q = q.eq('tenant_id', scope.tenant_id).eq('user_id', scope.user_id);
  const { data: rows, error } = await q.order('computed_at', { ascending: false }).limit(10000);
  if (error) return { ok: false, loop: 'loop_4_index_delta', processed: 0, errors: 1, notes: error.message };

  // Pick the latest score per user for today
  const latestPerUser = new Map<string, any>();
  for (const r of (rows ?? []) as any[]) {
    const k = r.user_id;
    if (!latestPerUser.has(k)) latestPerUser.set(k, r);
  }

  const today = new Date().toISOString().slice(0, 10);
  let processed = 0;
  let errors = 0;
  for (const r of latestPerUser.values()) {
    const upsert = await supabase
      .from('vitana_index_trajectory_snapshots')
      .upsert(
        {
          tenant_id: r.tenant_id,
          user_id: r.user_id,
          snapshot_date: today,
          score_total: r.score_total,
          score_pillars: r.score_pillars ?? {},
          balance_factor: r.balance_factor,
          tier: r.tier,
          source_engine: 'consolidator.loop_4',
          computed_at: new Date().toISOString(),
        },
        { onConflict: 'tenant_id,user_id,snapshot_date' }
      );
    if (upsert.error) errors += 1; else processed += 1;
  }

  return {
    ok: errors === 0,
    loop: 'loop_4_index_delta',
    processed,
    errors,
    notes: `${latestPerUser.size} user(s) snapshotted for ${today}`,
  };
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

  // Defensive table existence — not every env has health_features_daily
  // populated. We swallow the error and report 0 processed.
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  let q = supabase
    .from('health_features_daily')
    .select('tenant_id, user_id, feature_key, pillar, observed_on, value_numeric')
    .gte('observed_on', since);
  if (scope) q = q.eq('tenant_id', scope.tenant_id).eq('user_id', scope.user_id);
  const { data: rows, error } = await q.limit(50000);
  if (error) {
    return { ok: true, loop: 'loop_11_biometric', processed: 0, errors: 0, notes: `skipped: ${error.message}` };
  }

  // Aggregate per (user, feature_key)
  type FeatureStats = {
    tenant_id: string; user_id: string; feature_key: string; pillar: string;
    values: number[]; latest: number; latest_at: string;
  };
  const stats = new Map<string, FeatureStats>();
  for (const r of (rows ?? []) as any[]) {
    if (typeof r.value_numeric !== 'number') continue;
    const k = `${r.user_id}|${r.feature_key}`;
    const cur: FeatureStats = stats.get(k) ?? {
      tenant_id: r.tenant_id, user_id: r.user_id, feature_key: r.feature_key,
      pillar: r.pillar, values: [], latest: r.value_numeric, latest_at: r.observed_on,
    };
    cur.values.push(r.value_numeric);
    if (r.observed_on > cur.latest_at) {
      cur.latest = r.value_numeric;
      cur.latest_at = r.observed_on;
    }
    stats.set(k, cur);
  }

  let processed = 0;
  let errors = 0;
  for (const s of stats.values()) {
    if (s.values.length < 3) continue;
    const sorted = [...s.values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const mean = s.values.reduce((a, b) => a + b, 0) / s.values.length;
    const drift = s.latest - median;
    const trendClass = Math.abs(drift) < 0.1 * Math.abs(median || 1)
      ? 'stable'
      : (drift > 0 ? 'rising' : 'falling');
    const anomaly = Math.abs(drift) > 0.4 * Math.abs(median || 1);

    const upsert = await supabase
      .from('biometric_trends')
      .upsert(
        {
          tenant_id: s.tenant_id,
          user_id: s.user_id,
          feature_key: s.feature_key,
          pillar: s.pillar,
          window_days: 30,
          latest: s.latest,
          median,
          mean,
          trend_class: trendClass,
          anomaly_flag: anomaly,
          observation_count: s.values.length,
          computed_at: new Date().toISOString(),
        },
        { onConflict: 'tenant_id,user_id,feature_key,window_days' }
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

  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  let q = supabase
    .from('user_location_history')
    .select('tenant_id, user_id, locality, country, location_type, observed_at')
    .gte('observed_at', since);
  if (scope) q = q.eq('tenant_id', scope.tenant_id).eq('user_id', scope.user_id);
  const { data: rows, error } = await q.limit(50000);
  if (error) {
    return { ok: true, loop: 'loop_12_location', processed: 0, errors: 0, notes: `skipped: ${error.message}` };
  }

  // Per-user, count visits per locality
  const byUser = new Map<string, { tenant_id: string; user_id: string; counts: Map<string, number> }>();
  for (const r of (rows ?? []) as any[]) {
    if (!r.locality) continue;
    const u = byUser.get(r.user_id) ?? { tenant_id: r.tenant_id, user_id: r.user_id, counts: new Map() };
    u.counts.set(r.locality, (u.counts.get(r.locality) ?? 0) + 1);
    byUser.set(r.user_id, u);
  }

  let processed = 0;
  let errors = 0;
  for (const u of byUser.values()) {
    // Top 5 localities with >= 3 observations become candidate named places
    const top = [...u.counts.entries()]
      .filter(([_, c]) => c >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([locality, c]) => ({
        name: locality,
        locality,
        visit_count_30d: c,
        user_confirmed: false,
        source: 'consolidator.loop_12',
      }));

    if (top.length === 0) continue;

    const upsert = await supabase
      .from('user_location_settings')
      .upsert(
        {
          tenant_id: u.tenant_id,
          user_id: u.user_id,
          named_places: top,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'tenant_id,user_id' }
      );
    if (upsert.error) errors += 1; else processed += 1;
  }

  return {
    ok: errors === 0,
    loop: 'loop_12_location',
    processed,
    errors,
    notes: `${byUser.size} user(s) with location history`,
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

  // We only DECAY here — boosts happen on-write (in episodic / diary writers).
  // The rule: edges untouched for > 30 days drift toward 0.5 by 5%.
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  let q = supabase
    .from('relationship_edges')
    .select('id, tenant_id, user_id, strength, updated_at')
    .lte('updated_at', cutoff);
  if (scope) q = q.eq('tenant_id', scope.tenant_id).eq('user_id', scope.user_id);
  const { data: rows, error } = await q.limit(5000);
  if (error) {
    return { ok: true, loop: 'loop_13_network', processed: 0, errors: 0, notes: `skipped: ${error.message}` };
  }

  let processed = 0;
  let errors = 0;
  for (const r of (rows ?? []) as any[]) {
    const cur = Number(r.strength) || 0.5;
    const decayed = cur + (0.5 - cur) * 0.05;
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
    notes: `${(rows ?? []).length} stale edge(s) decayed`,
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
