/**
 * VTID-05159 (Health Hub Phase 1 / A2) — the health store's dark flag.
 *
 * The store is enabled only when ALL of these hold (plan Change 10):
 *   - HEALTH_STORE_ENABLED is exactly 'true';
 *   - VITANA_ENV is not 'staging' (staging shares the production Supabase
 *     project, so it is always off there, whatever the flag says);
 *   - HEALTH_RAW_BUCKET names the raw-batch bucket.
 *
 * Off -> writeHealthSamples and every reader answer STORE_DISABLED without
 * reading anything, and the internal routes answer
 * 404 {error:'HEALTH_STORE_DISABLED'} without reading the body.
 * GET /api/v1/health/internal/store-status reports why (getHealthStoreStatus).
 *
 * No task definition sets the flag in this package; production go-live is
 * its own Gate 2 (plan Rollout 6).
 */

export const HEALTH_STORE_VTID = 'VTID-05159';

export type HealthStoreDisabledReason = 'staging' | 'flag_off' | 'bucket_missing';

export interface HealthStoreStatus {
  enabled: boolean;
  /** Why the store is off; null when it is on. */
  reason: HealthStoreDisabledReason | null;
}

export function healthRawBucket(env: NodeJS.ProcessEnv = process.env): string | null {
  const b = (env.HEALTH_RAW_BUCKET ?? '').trim();
  return b.length > 0 ? b : null;
}

/** The store's state and, when off, the first reason in the order staging > flag > bucket. */
export function getHealthStoreStatus(env: NodeJS.ProcessEnv = process.env): HealthStoreStatus {
  if (env.VITANA_ENV === 'staging') return { enabled: false, reason: 'staging' };
  if (env.HEALTH_STORE_ENABLED !== 'true') return { enabled: false, reason: 'flag_off' };
  if (!healthRawBucket(env)) return { enabled: false, reason: 'bucket_missing' };
  return { enabled: true, reason: null };
}

export function isHealthStoreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return getHealthStoreStatus(env).enabled;
}

/**
 * Raw-batch erasure (POST /erase-raw, withdrawal) runs whenever a bucket is
 * configured outside staging, even with HEALTH_STORE_ENABLED off: a rollback
 * unsets the flag but leaves up to 30 days of raw batches in the bucket, and
 * erasure must still reach them (GDPR Art. 17). With no bucket there is
 * nothing to erase.
 */
export function isHealthRawErasureAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VITANA_ENV !== 'staging' && healthRawBucket(env) !== null;
}
