// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: the
// only test reference (test/routes/admin-memory-broker.test.ts) is a
// wholesale jest.mock('../../src/services/nightly-consolidator', ...) —
// zero genuine coverage of this module's own DB logic.
/**
 * services/nightly-consolidator.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in nightly-consolidator.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic
 * (including the optional per-loop `scope` eq-chain), same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

type Scope = { tenant_id: string; user_id: string } | undefined;

export async function insertConsolidatorRun(
  sb: SupabaseClient,
  triggeredBy: string,
  tenantId: string | null,
) {
  return sb
    .from('consolidator_runs')
    .insert({ triggered_by: triggeredBy, tenant_id: tenantId, status: 'running' })
    .select('id')
    .single();
}

export async function updateConsolidatorRun(
  sb: SupabaseClient,
  runId: string,
  patch: { finished_at: string; status: string; summary: Record<string, unknown> },
) {
  return sb.from('consolidator_runs').update(patch).eq('id', runId);
}

export async function fetchIndexDeltaObservations(sb: SupabaseClient, sinceIso: string, scope: Scope) {
  let q = sb
    .from('index_delta_observations')
    .select('tenant_id, user_id, pillar, predicted_delta, observed_delta, created_at')
    .gte('created_at', sinceIso);
  if (scope) q = q.eq('tenant_id', scope.tenant_id).eq('user_id', scope.user_id);
  return q.limit(5000);
}

export async function insertDriftAdaptationPlan(
  sb: SupabaseClient,
  row: {
    tenant_id: string;
    user_id: string;
    drift_kind: string;
    detected_pillar: string;
    drift_magnitude: number;
    recommended_actions: unknown[];
    source_engine: string;
  },
) {
  return sb.from('drift_adaptation_plans').insert(row);
}

export async function fetchVitanaIndexScoresForTrajectory(sb: SupabaseClient, sinceDate: string, scope: Scope) {
  let q = sb
    .from('vitana_index_scores')
    .select('tenant_id, user_id, date, score_total, score_sleep, score_nutrition, score_exercise, score_hydration, score_mental, model_version')
    .gte('date', sinceDate);
  if (scope) q = q.eq('tenant_id', scope.tenant_id).eq('user_id', scope.user_id);
  return q.order('date', { ascending: true }).limit(10000);
}

export async function upsertVitanaIndexTrajectorySnapshot(
  sb: SupabaseClient,
  row: {
    tenant_id: string;
    user_id: string;
    snapshot_date: string;
    time_window: string;
    narrative: string;
    pillars_snapshot: Record<string, unknown>;
    balance_factor_avg: number | null;
    tier_at_start: string;
    tier_at_end: string;
    trajectory_class: string;
  },
) {
  return sb.from('vitana_index_trajectory_snapshots').upsert(row, { onConflict: 'tenant_id,user_id,snapshot_date,time_window' });
}

export async function countDiaryEntriesSince(sb: SupabaseClient, sinceIso: string, scope: Scope) {
  let q = sb.from('memory_diary_entries').select('id', { count: 'exact', head: true }).gte('created_at', sinceIso);
  if (scope) q = q.eq('tenant_id', scope.tenant_id).eq('user_id', scope.user_id);
  return q;
}

export async function fetchHealthFeaturesDailyForTrends(sb: SupabaseClient, sinceDate: string, scope: Scope) {
  let q = sb.from('health_features_daily').select('tenant_id, user_id, feature_key, date, feature_value').gte('date', sinceDate);
  if (scope) q = q.eq('tenant_id', scope.tenant_id).eq('user_id', scope.user_id);
  return q.limit(50000);
}

export async function upsertBiometricTrend(
  sb: SupabaseClient,
  row: {
    tenant_id: string;
    user_id: string;
    feature_key: string;
    pillar: string;
    mean_7d: number | null;
    mean_30d: number;
    std_30d: number;
    latest: number;
    latest_z_score: number;
    trend_class: string;
    anomaly_flag: boolean;
    last_anomaly_at: string | null;
    computed_at: string;
  },
) {
  return sb.from('biometric_trends').upsert(row, { onConflict: 'tenant_id,user_id,feature_key' });
}

export async function fetchUserLocationHistory(sb: SupabaseClient, sinceIso: string, scope: Scope) {
  let q = sb
    .from('user_location_history')
    .select('tenant_id, user_id, locality, country, timezone, location_type, valid_from')
    .gte('valid_from', sinceIso);
  if (scope) q = q.eq('tenant_id', scope.tenant_id).eq('user_id', scope.user_id);
  return q.limit(50000);
}

export async function upsertUserLocationSetting(
  sb: SupabaseClient,
  row: {
    tenant_id: string;
    user_id: string;
    name: string;
    locality: string;
    country: string | null;
    timezone: string | null;
    is_primary_home: boolean;
    user_confirmed: boolean;
  },
) {
  return sb.from('user_location_settings').upsert(row, { onConflict: 'tenant_id,user_id,name' });
}

export async function fetchStaleRelationshipEdges(sb: SupabaseClient, cutoffIso: string, scope: Scope) {
  let q = sb
    .from('relationship_edges')
    .select('id, tenant_id, source_id, target_id, strength, last_interaction_at')
    .lte('last_interaction_at', cutoffIso);
  if (scope) {
    q = q.eq('tenant_id', scope.tenant_id);
    q = q.eq('source_id', scope.user_id);
  }
  return q.limit(5000);
}

export async function updateRelationshipEdgeStrength(sb: SupabaseClient, edgeId: string, strength: number) {
  return sb.from('relationship_edges').update({ strength, updated_at: new Date().toISOString() }).eq('id', edgeId);
}

export async function fetchDeviceSessionLog(sb: SupabaseClient, sinceIso: string, scope: Scope) {
  let q = sb.from('user_device_session_log').select('tenant_id, user_id, device_token_id, started_at').gte('started_at', sinceIso);
  if (scope) q = q.eq('tenant_id', scope.tenant_id).eq('user_id', scope.user_id);
  return q.limit(50000);
}

export async function updateDeviceTokenPrimary(sb: SupabaseClient, deviceTokenId: string) {
  return sb.from('user_device_tokens').update({ is_primary: true, updated_at: new Date().toISOString() }).eq('id', deviceTokenId);
}
