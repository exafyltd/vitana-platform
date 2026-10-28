/**
 * VTID-05089 (Health Hub D6a): wearable data -> health_features_daily bridge.
 *
 * Verified vendor webhooks already persist daily wearable metrics and
 * workouts (routes/connector-webhooks.ts -> wearable_daily_metrics /
 * wearable_workouts). Nothing turned them into the `health_features_daily`
 * rows the Vitana Index counts. This module does, for the member-days a
 * webhook request just persisted:
 *
 *   1. merge every provider's row for the member-day (read from the
 *      database, not from the event, so the result is the same whatever
 *      order or provider the deliveries came in);
 *   2. map the Index-relevant columns to feature keys, dropping implausible
 *      values (nothing is invented);
 *   3. write with device-never-overwrites-member precedence: insert-only,
 *      then update only rows the bridge itself wrote
 *      (metadata.source = 'wearable_bridge');
 *   4. recompute the member's Vitana Index once per call;
 *   5. emit one OASIS event carrying keys, dates, providers and counts —
 *      never a health value.
 *
 * DARK BY DEFAULT. Runs only when WEARABLE_FEATURE_BRIDGE_ENABLED is exactly
 * 'true' AND the process is not staging. Staging shares the production
 * database, so it is hard-blocked even if the flag is set there by mistake.
 * `sharedDbLoopAllowed()` is deliberately not used: it is a staging guard
 * that returns true on every non-staging environment, not a feature toggle.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { emitOasisEvent } from './oasis-event-service';
import { fetchExcludedTestServiceAccountIds } from '../lib/excluded-test-service-accounts';
import * as repo from './wearable-features-bridge-repository';

export const BRIDGE_SOURCE = 'wearable_bridge';
export const BRIDGE_CONFIDENCE = 0.9;

export function isWearableFeatureBridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WEARABLE_FEATURE_BRIDGE_ENABLED === 'true' && env.VITANA_ENV !== 'staging';
}

// ---------------------------------------------------------------------------
// Pure mapping
// ---------------------------------------------------------------------------

export interface DailyMetricsRow {
  provider: string;
  metric_date: string;
  updated_at?: string | null;
  sleep_minutes?: number | string | null;
  sleep_efficiency_pct?: number | string | null;
  hrv_avg_ms?: number | string | null;
  hrv_rmssd_ms?: number | string | null;
  resting_hr?: number | string | null;
  steps?: number | string | null;
  vo2max?: number | string | null;
  workout_count?: number | string | null;
}

export interface WorkoutRow {
  provider: string;
  started_at: string;
}

export interface BridgedFeature {
  feature_key: string;
  feature_value: number;
  feature_unit: string;
  sample_count: number;
  provider: string;
}

interface ColumnSpec {
  key: string;
  unit: string;
  min: number;
  max: number;
  read: (r: DailyMetricsRow) => unknown;
}

/** Column -> feature key, unit and plausibility bounds (inclusive). */
export const COLUMN_FEATURES: readonly ColumnSpec[] = [
  { key: 'wearable_sleep_duration', unit: 'min', min: 1, max: 1440, read: (r) => r.sleep_minutes },
  { key: 'wearable_sleep_efficiency', unit: '%', min: 0, max: 100, read: (r) => r.sleep_efficiency_pct },
  { key: 'wearable_hrv', unit: 'ms', min: 1, max: 300, read: (r) => r.hrv_avg_ms ?? r.hrv_rmssd_ms },
  { key: 'wearable_heart_rate', unit: 'bpm', min: 25, max: 220, read: (r) => r.resting_hr },
  { key: 'wearable_steps', unit: 'steps', min: 0, max: 100000, read: (r) => r.steps },
  { key: 'vo2_max', unit: 'ml/kg/min', min: 10, max: 95, read: (r) => r.vo2max },
];

export const WORKOUT_FEATURE_KEY = 'wearable_workout';

function toFiniteNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function updatedAtMs(r: DailyMetricsRow): number {
  const t = r.updated_at ? Date.parse(r.updated_at) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/**
 * Map one member-day's wearable_daily_metrics rows (any number of providers)
 * plus that day's wearable_workouts rows to Index features.
 *
 * Per column, the plausible value from the row with the latest `updated_at`
 * wins and its provider is recorded. `sample_count` is the number of rows
 * that had a plausible value for that column. Out-of-bounds and null values
 * are dropped, never clamped. `wearable_sleep_stages` / `wearable_stress`
 * have no honest source column and are never produced.
 */
export function mapDailyMetricsToFeatures(
  rows: DailyMetricsRow[],
  workouts: WorkoutRow[] = [],
): BridgedFeature[] {
  const sorted = [...rows].sort((a, b) => updatedAtMs(b) - updatedAtMs(a)); // latest first
  const out: BridgedFeature[] = [];

  for (const spec of COLUMN_FEATURES) {
    let winner: { value: number; provider: string } | null = null;
    let contributing = 0;
    for (const r of sorted) {
      const n = toFiniteNumber(spec.read(r));
      if (n === null || n < spec.min || n > spec.max) continue;
      contributing++;
      if (!winner) winner = { value: n, provider: r.provider };
    }
    if (winner) {
      out.push({
        feature_key: spec.key,
        feature_value: winner.value,
        feature_unit: spec.unit,
        sample_count: contributing,
        provider: winner.provider,
      });
    }
  }

  // Workouts: max(latest daily workout_count, rows in wearable_workouts that day).
  let dailyCount = 0;
  let dailyProvider: string | null = null;
  let dailyContributing = 0;
  for (const r of sorted) {
    const n = toFiniteNumber(r.workout_count);
    if (n === null || n < 0) continue;
    dailyContributing++;
    if (dailyProvider === null) {
      dailyCount = Math.floor(n);
      dailyProvider = r.provider;
    }
  }
  const tableCount = workouts.length;
  const count = Math.max(dailyCount, tableCount);
  if (count > 0) {
    const fromTable = tableCount >= dailyCount;
    const provider = fromTable
      ? Array.from(new Set(workouts.map((w) => w.provider))).sort().join('+')
      : (dailyProvider as string);
    out.push({
      feature_key: WORKOUT_FEATURE_KEY,
      feature_value: count,
      feature_unit: 'count',
      sample_count: fromTable ? tableCount : dailyContributing,
      provider,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

export interface BridgeInput {
  tenantId: string;
  userId: string;
  dates: string[];
}

export interface BridgeOptions {
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

export type BridgeResult =
  | { ok: true; skipped: 'disabled' | 'excluded_account' | 'no_dates' }
  | { ok: true; features_written: number; days: number; index_recomputed: boolean }
  | { ok: false; error_code: string };

class BridgeError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** UTC calendar date of an ISO timestamp, or null when it does not parse. */
export function utcDateOf(ts: unknown): string | null {
  if (typeof ts !== 'string') return null;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

async function safeEmit(event: Parameters<typeof emitOasisEvent>[0]): Promise<void> {
  try {
    await emitOasisEvent(event);
  } catch {
    /* OASIS is best-effort here; the bridge result never depends on it */
  }
}

function nextUtcDate(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Bridge the given member-days. Never throws: a failure emits
 * `health.wearable_features.bridge_failed` with an error code (never raw
 * values) and resolves `{ ok: false }`.
 */
export async function bridgeWearableDays(
  sb: SupabaseClient,
  input: BridgeInput,
  opts: BridgeOptions = {},
): Promise<BridgeResult> {
  const env = opts.env ?? process.env;
  if (!isWearableFeatureBridgeEnabled(env)) return { ok: true, skipped: 'disabled' };

  const { tenantId, userId } = input;
  const dates = Array.from(new Set((input.dates || []).filter((d) => DATE_RE.test(d)))).sort();
  if (!tenantId || !userId || dates.length === 0) return { ok: true, skipped: 'no_dates' };

  try {
    const excluded = await fetchExcludedTestServiceAccountIds(sb);
    if (excluded.has(userId)) return { ok: true, skipped: 'excluded_account' };

    const daily = await repo.fetchDailyMetricsForDates(sb, tenantId, userId, dates);
    if (daily?.error) throw new BridgeError('read_daily_metrics_failed');
    const fromIso = `${dates[0]}T00:00:00.000Z`;
    const toIso = `${nextUtcDate(dates[dates.length - 1])}T00:00:00.000Z`;
    const wk = await repo.fetchWorkoutsInRange(sb, tenantId, userId, fromIso, toIso);
    if (wk?.error) throw new BridgeError('read_workouts_failed');

    const dailyRows = ((daily?.data as DailyMetricsRow[] | null) || []);
    const workoutRows = ((wk?.data as WorkoutRow[] | null) || []);
    const nowIso = (opts.now ?? new Date()).toISOString();

    const rows: Array<Record<string, unknown> & { feature_key: string; date: string }> = [];
    const providers = new Set<string>();
    for (const date of dates) {
      const dayRows = dailyRows.filter((r) => r.metric_date === date);
      const dayWorkouts = workoutRows.filter((w) => utcDateOf(w.started_at) === date);
      for (const f of mapDailyMetricsToFeatures(dayRows, dayWorkouts)) {
        for (const p of f.provider.split('+')) if (p) providers.add(p);
        rows.push({
          tenant_id: tenantId,
          user_id: userId,
          date,
          feature_key: f.feature_key,
          feature_value: f.feature_value,
          feature_unit: f.feature_unit,
          sample_count: f.sample_count,
          confidence: BRIDGE_CONFIDENCE,
          metadata: { source: BRIDGE_SOURCE, provider: f.provider, metric_date: date },
          updated_at: nowIso,
        });
      }
    }

    let indexRecomputed = false;
    if (rows.length > 0) {
      const ins = await repo.insertFeatureRowsIgnoringExisting(sb, rows);
      if (ins?.error) throw new BridgeError('insert_features_failed');
      for (const row of rows) {
        const { tenant_id, user_id, date, feature_key, ...patch } = row as Record<string, unknown> & {
          tenant_id: string; user_id: string; date: string; feature_key: string;
        };
        const up = await repo.updateBridgeOwnedFeatureRow(sb, { tenant_id, user_id, date, feature_key }, patch);
        if (up?.error) throw new BridgeError('update_features_failed');
      }
      const today = (opts.now ?? new Date()).toISOString().slice(0, 10);
      const rpc = await repo.computeVitanaIndexForUser(sb, userId, today, {
        trigger: 'wearable_sync',
        sourceKind: 'wearable_bridge',
        sourceRef: Array.from(providers).sort().join(',') || null,
      });
      if (rpc?.error) throw new BridgeError('index_recompute_failed');
      indexRecomputed = true;
    }

    const featureKeys = Array.from(new Set(rows.map((r) => r.feature_key))).sort();
    await safeEmit({
      vtid: 'VTID-05089',
      type: 'health.wearable_features.bridged',
      source: 'gateway',
      status: 'info',
      message: `wearable features bridged: ${rows.length} row(s) over ${dates.length} day(s)`,
      actor_id: userId,
      actor_role: 'system',
      surface: 'system',
      payload: {
        feature_keys: featureKeys,
        dates,
        providers: Array.from(providers).sort(),
        rows_written: rows.length,
        days: dates.length,
        index_recomputed: indexRecomputed,
      },
    });

    return { ok: true, features_written: rows.length, days: dates.length, index_recomputed: indexRecomputed };
  } catch (err: unknown) {
    const code = err instanceof BridgeError ? err.code : 'exception';
    await safeEmit({
      vtid: 'VTID-05089',
      type: 'health.wearable_features.bridge_failed',
      source: 'gateway',
      status: 'error',
      message: `wearable features bridge failed: ${code}`,
      actor_id: userId,
      actor_role: 'system',
      surface: 'system',
      payload: { error_code: code, dates, days: dates.length },
    });
    return { ok: false, error_code: code };
  }
}
