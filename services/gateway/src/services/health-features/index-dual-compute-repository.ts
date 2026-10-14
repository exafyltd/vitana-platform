// Coverage note: test/health-features/index-dual-compute*.test.ts drive the
// dual-compute through an in-memory IndexDualComputeRepository; these thin
// wrappers are the Supabase/PostgREST seam (the B1/B2 repository pattern).
/**
 * VTID-05163 (Health Hub Phase 1 / B3) — data access for the Vitana Index
 * dual-compute (plan Changes 10–12). Everything here READS, except the
 * dual-compute table itself (`vitana_index_dual_compute`, service role, Aurora
 * only) and its 120-day purge. The projection is the read-only SQL function
 * `vitana_index_project_for_user` (STABLE; migration
 * 20261014100800_vtid_05163_index_dual_compute.sql). Client-agnostic; every
 * decision lives in index-dual-compute.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { DailyMetricsRow, WorkoutRow } from '../wearable-features-bridge';
import {
  HEALTH_FEATURES_LEGACY_SHADOW_TABLE,
  HEALTH_FEATURES_PENDING_TABLE,
  HEALTH_FEATURES_V2_TABLE,
  LIVE_FEATURES_TABLE,
  type RepoError,
  type RepoResult,
} from './health-features-repository';

export const INDEX_DUAL_COMPUTE_TABLE = 'vitana_index_dual_compute';
export const INDEX_PROJECTION_RPC = 'vitana_index_project_for_user';

export interface ProjectionPillar {
  baseline: number;
  completions: number;
  data: number;
  streak: number;
}

export interface ProjectionResult {
  ok: boolean;
  score_total: number;
  balance_factor?: number;
  confidence?: number;
  subscores: Record<string, ProjectionPillar>;
}

export interface LiveScoreRow {
  score_total: number | null;
  model_version: string | null;
  feature_inputs: Record<string, unknown> | null;
}

export interface FeatureKeyRow {
  date: string;
  feature_key: string;
  metadata?: Record<string, unknown> | null;
}

export interface DualComputeRow {
  tenant_id: string;
  user_id: string;
  date: string;
  scope: 'device' | 'all';
  live_total: number | null;
  legacy_total: number | null;
  v2_total: number | null;
  legacy_pillars: Record<string, { data: number; streak: number }> | null;
  v2_pillars: Record<string, { data: number; streak: number }> | null;
  device_rows_missing: number;
  device_rows_extra: number;
  self_rows_missing: number;
  self_rows_extra: number;
  diff_class: string[];
  formula_ok: boolean | null;
  failure_code: string | null;
  computed_at: string;
}

/** What the report reads: no tenant, no member id — aggregates are built from these. */
export type DualComputeReportRow = Omit<DualComputeRow, 'tenant_id' | 'legacy_pillars' | 'v2_pillars' | 'computed_at'>;

export interface IndexDualComputeRepository {
  project(userId: string, deviceFrom: string | null, selfFrom: string | null): Promise<RepoResult<ProjectionResult>>;
  fetchLiveScore(tenantId: string, userId: string, date: string): Promise<RepoResult<LiveScoreRow | null>>;
  /** health_features_daily rows of the member (every tenant: the Index counts by user) from `from`. */
  listLegacyRows(userId: string, from: string): Promise<RepoResult<FeatureKeyRow[]>>;
  listShadowRows(userId: string, from: string): Promise<RepoResult<FeatureKeyRow[]>>;
  listV2Rows(userId: string, from: string): Promise<RepoResult<FeatureKeyRow[]>>;
  listPendingDates(userId: string): Promise<RepoResult<Array<{ date: string }>>>;
  listDailyMetrics(tenantId: string, userId: string, from: string): Promise<RepoResult<DailyMetricsRow[]>>;
  listWorkouts(tenantId: string, userId: string, fromIso: string): Promise<RepoResult<WorkoutRow[]>>;
  upsertRows(rows: DualComputeRow[]): Promise<RepoResult<unknown>>;
  purgeBefore(date: string): Promise<RepoResult<unknown>>;
  /** Report rows for [from, to] and one scope (no member ids selected). */
  listReportRows(from: string, to: string, scope: 'device' | 'all', limit: number): Promise<RepoResult<DualComputeReportRow[]>>;
}

async function wrap<T>(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<RepoResult<T>> {
  try {
    const { data, error } = await q;
    return { data: (data as T) ?? null, error: (error as RepoError) ?? null };
  } catch (err) {
    return { data: null, error: { code: 'THREW', message: err instanceof Error ? err.name : typeof err } };
  }
}

const ROW_LIMIT = 20_000;

export function indexDualComputeRepository(sb: SupabaseClient): IndexDualComputeRepository {
  return {
    project: (userId, deviceFrom, selfFrom) =>
      wrap(sb.rpc(INDEX_PROJECTION_RPC, { p_user_id: userId, p_device_from: deviceFrom, p_self_from: selfFrom })),
    fetchLiveScore: (tenantId, userId, date) =>
      wrap(sb.from('vitana_index_scores').select('score_total, model_version, feature_inputs')
        .eq('tenant_id', tenantId).eq('user_id', userId).eq('date', date).maybeSingle()),
    listLegacyRows: (userId, from) =>
      wrap(sb.from(LIVE_FEATURES_TABLE).select('date, feature_key, metadata').eq('user_id', userId).gte('date', from).limit(ROW_LIMIT)),
    listShadowRows: (userId, from) =>
      wrap(sb.from(HEALTH_FEATURES_LEGACY_SHADOW_TABLE).select('date, feature_key, metadata').eq('user_id', userId).gte('date', from).limit(ROW_LIMIT)),
    listV2Rows: (userId, from) =>
      wrap(sb.from(HEALTH_FEATURES_V2_TABLE).select('date, feature_key').eq('user_id', userId).gte('date', from).limit(ROW_LIMIT)),
    listPendingDates: (userId) => wrap(sb.from(HEALTH_FEATURES_PENDING_TABLE).select('date').eq('user_id', userId).limit(ROW_LIMIT)),
    listDailyMetrics: (tenantId, userId, from) =>
      wrap(sb.from('wearable_daily_metrics')
        .select('provider, metric_date, updated_at, sleep_minutes, sleep_efficiency_pct, hrv_avg_ms, hrv_rmssd_ms, resting_hr, steps, vo2max, workout_count')
        .eq('tenant_id', tenantId).eq('user_id', userId).gte('metric_date', from).limit(ROW_LIMIT)),
    listWorkouts: (tenantId, userId, fromIso) =>
      wrap(sb.from('wearable_workouts').select('provider, started_at').eq('tenant_id', tenantId).eq('user_id', userId).gte('started_at', fromIso).limit(ROW_LIMIT)),
    upsertRows: (rows) => wrap(sb.from(INDEX_DUAL_COMPUTE_TABLE).upsert(rows, { onConflict: 'tenant_id,user_id,date,scope' })),
    purgeBefore: (date) => wrap(sb.from(INDEX_DUAL_COMPUTE_TABLE).delete().lt('date', date)),
    listReportRows: (from, to, scope, limit) =>
      wrap(sb.from(INDEX_DUAL_COMPUTE_TABLE)
        .select('user_id, date, scope, live_total, legacy_total, v2_total, device_rows_missing, device_rows_extra, self_rows_missing, self_rows_extra, diff_class, formula_ok, failure_code')
        .eq('scope', scope).gte('date', from).lte('date', to).order('date', { ascending: true }).limit(limit)),
  };
}

/** Table or projection absent (Aurora-only, not applied). */
export function isDualComputeStoreMissing(error: RepoError | null | undefined): boolean {
  if (!error) return false;
  const code = typeof error.code === 'string' ? error.code : '';
  if (code === '42P01' || code === '42883' || code === 'PGRST205' || code === 'PGRST202') return true;
  const message = typeof error.message === 'string' ? error.message : '';
  return /(vitana_index_dual_compute|vitana_index_project_for_user|health_features_daily_v2)/.test(message)
    && /does not exist|schema cache|could not find/i.test(message);
}

export function dualComputeErrorCode(error: RepoError | null | undefined): 'DUAL_COMPUTE_STORE_PENDING' | 'DUAL_COMPUTE_STORE_UNAVAILABLE' {
  return isDualComputeStoreMissing(error) ? 'DUAL_COMPUTE_STORE_PENDING' : 'DUAL_COMPUTE_STORE_UNAVAILABLE';
}
