/**
 * VTID-05089 (Health Hub D6a): data-access seam for the wearable features
 * bridge (services/wearable-features-bridge.ts). Same pattern as
 * routes/connector-webhooks-repository.ts: thin Supabase wrappers that take
 * `sb` as a parameter, no behaviour of their own.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { recordIndexRecompute, type IndexRecomputeTrigger } from './vitana-index/record-recompute';

export const HEALTH_FEATURES_CONFLICT = 'tenant_id,user_id,date,feature_key';

export async function fetchDailyMetricsForDates(
  sb: SupabaseClient,
  tenantId: string,
  userId: string,
  dates: string[],
) {
  return sb
    .from('wearable_daily_metrics')
    .select(
      'provider, metric_date, updated_at, sleep_minutes, sleep_efficiency_pct, hrv_avg_ms, hrv_rmssd_ms, resting_hr, steps, vo2max, workout_count',
    )
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .in('metric_date', dates);
}

/** Workouts whose started_at falls in [fromIso, toIso). */
export async function fetchWorkoutsInRange(
  sb: SupabaseClient,
  tenantId: string,
  userId: string,
  fromIso: string,
  toIso: string,
) {
  return sb
    .from('wearable_workouts')
    .select('provider, started_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .gte('started_at', fromIso)
    .lt('started_at', toIso);
}

/**
 * Insert-only: a row that already exists for (tenant, user, date, key) is
 * left untouched, whoever wrote it.
 */
export async function insertFeatureRowsIgnoringExisting(sb: SupabaseClient, rows: Record<string, unknown>[]) {
  return sb.from('health_features_daily').upsert(rows, {
    onConflict: HEALTH_FEATURES_CONFLICT,
    ignoreDuplicates: true,
  });
}

/**
 * Update a feature row only when the bridge itself wrote it
 * (metadata.source = 'wearable_bridge'). A member's own voice, diary or
 * manual row for the same key and day never matches this filter.
 */
export async function updateBridgeOwnedFeatureRow(
  sb: SupabaseClient,
  key: { tenant_id: string; user_id: string; date: string; feature_key: string },
  patch: Record<string, unknown>,
) {
  return sb
    .from('health_features_daily')
    .update(patch)
    .eq('tenant_id', key.tenant_id)
    .eq('user_id', key.user_id)
    .eq('date', key.date)
    .eq('feature_key', key.feature_key)
    .filter('metadata->>source', 'eq', 'wearable_bridge');
}

/** VTID-05168: locked + recorded recompute (see services/vitana-index/record-recompute.ts). */
export async function computeVitanaIndexForUser(
  sb: SupabaseClient,
  userId: string,
  date: string,
  source: { trigger?: IndexRecomputeTrigger; sourceKind?: string | null; sourceRef?: string | null } = {},
) {
  return recordIndexRecompute(sb, {
    userId,
    date: date,
    trigger: source.trigger ?? 'wearable_sync',
    sourceKind: source.sourceKind ?? null,
    sourceRef: source.sourceRef ?? null,
  });
}
