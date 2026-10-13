// Coverage note: test/health-features/*.test.ts drive health-features through
// an in-memory implementation of HealthFeaturesRepository; these thin
// wrappers are the Supabase/PostgREST seam (the B1 repository pattern,
// VTID-03702).
/**
 * VTID-05162 (Health Hub Phase 1 / B2) — data access for B2's three tables
 * (migration 20261014100700_vtid_05162_health_features_v2.sql, Aurora only):
 *   - health_features_daily_v2            the derived shadow of health_features_daily;
 *   - health_features_derivation_pending  one marker per member-day awaiting derivation;
 *   - health_features_daily_legacy_shadow created empty, used only after B3's cutover
 *                                          (no accessor here yet).
 * Client-agnostic; every decision lives in the callers. Never touches the
 * health store's own tables (S5): those are package A's.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const HEALTH_FEATURES_V2_TABLE = 'health_features_daily_v2';
export const HEALTH_FEATURES_LEGACY_SHADOW_TABLE = 'health_features_daily_legacy_shadow';
export const HEALTH_FEATURES_PENDING_TABLE = 'health_features_derivation_pending';
/** B2's tables (vtid-05025 commerce boundary test, Aurora parity scripts). */
export const HEALTH_FEATURES_TABLES = [HEALTH_FEATURES_V2_TABLE, HEALTH_FEATURES_LEGACY_SHADOW_TABLE, HEALTH_FEATURES_PENDING_TABLE] as const;

export interface RepoError {
  code?: string;
  message?: string;
}
export interface RepoResult<T> {
  data: T | null;
  error: RepoError | null;
}

export interface FeatureV2Row {
  tenant_id: string;
  user_id: string;
  date: string;
  feature_key: string;
  feature_value: number;
  feature_unit: string;
  sample_count: number;
  confidence: number;
  metadata: Record<string, unknown>;
  derivation_version: string;
  source_kinds: string[];
  updated_at: string;
}

export interface PendingMarker {
  tenant_id: string;
  user_id: string;
  date: string;
  enqueued_at: string;
  attempts: number;
}

export interface HealthFeaturesRepository {
  upsertFeaturesV2(rows: FeatureV2Row[]): Promise<RepoResult<unknown>>;
  listFeaturesV2Keys(tenantId: string, userId: string, dates: string[]): Promise<RepoResult<Array<{ date: string; feature_key: string }>>>;
  deleteFeaturesV2(tenantId: string, userId: string, date: string, keys: string[]): Promise<RepoResult<unknown>>;
  listFeaturesV2Dates(tenantId: string, userId: string): Promise<RepoResult<Array<{ date: string }>>>;
  upsertPending(rows: Array<{ tenant_id: string; user_id: string; date: string; enqueued_at: string }>): Promise<RepoResult<unknown>>;
  deletePending(tenantId: string, userId: string, dates: string[]): Promise<RepoResult<unknown>>;
  listStalePending(beforeIso: string, limit: number): Promise<RepoResult<PendingMarker[]>>;
  setPendingAttempts(tenantId: string, userId: string, date: string, attempts: number): Promise<RepoResult<unknown>>;
}

async function wrap<T>(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<RepoResult<T>> {
  try {
    const { data, error } = await q;
    return { data: (data as T) ?? null, error: (error as RepoError) ?? null };
  } catch (err) {
    return { data: null, error: { code: 'THREW', message: err instanceof Error ? err.name : typeof err } };
  }
}

export function healthFeaturesRepository(sb: SupabaseClient): HealthFeaturesRepository {
  return {
    upsertFeaturesV2: (rows) => wrap(sb.from(HEALTH_FEATURES_V2_TABLE).upsert(rows, { onConflict: 'tenant_id,user_id,date,feature_key' })),
    listFeaturesV2Keys: (tenantId, userId, dates) =>
      wrap(sb.from(HEALTH_FEATURES_V2_TABLE).select('date, feature_key').eq('tenant_id', tenantId).eq('user_id', userId).in('date', dates)),
    deleteFeaturesV2: (tenantId, userId, date, keys) =>
      wrap(sb.from(HEALTH_FEATURES_V2_TABLE).delete().eq('tenant_id', tenantId).eq('user_id', userId).eq('date', date).in('feature_key', keys)),
    listFeaturesV2Dates: (tenantId, userId) =>
      wrap(sb.from(HEALTH_FEATURES_V2_TABLE).select('date').eq('tenant_id', tenantId).eq('user_id', userId).order('date', { ascending: true }).limit(5000)),
    upsertPending: (rows) => wrap(sb.from(HEALTH_FEATURES_PENDING_TABLE).upsert(rows, { onConflict: 'tenant_id,user_id,date' })),
    deletePending: (tenantId, userId, dates) =>
      wrap(sb.from(HEALTH_FEATURES_PENDING_TABLE).delete().eq('tenant_id', tenantId).eq('user_id', userId).in('date', dates)),
    listStalePending: (beforeIso, limit) =>
      wrap(
        sb
          .from(HEALTH_FEATURES_PENDING_TABLE)
          .select('tenant_id, user_id, date, enqueued_at, attempts')
          .lt('enqueued_at', beforeIso)
          .order('enqueued_at', { ascending: true })
          .limit(limit),
      ),
    setPendingAttempts: (tenantId, userId, date, attempts) =>
      wrap(sb.from(HEALTH_FEATURES_PENDING_TABLE).update({ attempts }).eq('tenant_id', tenantId).eq('user_id', userId).eq('date', date)),
  };
}

/** Table absent (Aurora-only, not applied) — the D10 isConsentStoreMissing pattern. */
export function isHealthFeaturesStoreMissing(error: RepoError | null | undefined): boolean {
  if (!error) return false;
  const code = typeof error.code === 'string' ? error.code : '';
  if (code === '42P01' || code === 'PGRST205' || code === 'PGRST202') return true;
  const message = typeof error.message === 'string' ? error.message : '';
  return /health_features_(daily_v2|derivation_pending|daily_legacy_shadow)/.test(message) && /does not exist|schema cache|could not find/i.test(message);
}

export function featuresErrorCode(error: RepoError | null | undefined): 'FEATURES_STORE_PENDING' | 'FEATURES_STORE_UNAVAILABLE' {
  return isHealthFeaturesStoreMissing(error) ? 'FEATURES_STORE_PENDING' : 'FEATURES_STORE_UNAVAILABLE';
}
