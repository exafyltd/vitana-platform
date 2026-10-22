/**
 * VTID-05270 (mt-jobs, lane jobs-tenant-loop): the shared multi-tenant flags.
 *
 * Every mt-jobs change is dark by default: the jobs loop over active tenants
 * only when BOTH the env master `MT_RESOLUTION_V2=true` is set on the gateway
 * AND the tenant's own `tenant_settings.feature_flags.mt.jobs_tenant_loop` is
 * truthy. `feature_flags` is the existing JSONB column
 * (20260412300000_tenant_settings.sql:12); `mt.jobs_tenant_loop` is a new key
 * inside it, absent ⇒ off. No schema change.
 *
 * mt-launch and the M2 flag flips import this module; keep it free of DB and
 * network access.
 */

export type MtEnv = Record<string, string | undefined>;

/** The subset of a `tenant_settings` row the flag reads. */
export interface MtTenantSettings {
  feature_flags?: unknown;
}

/** The env master: `MT_RESOLUTION_V2=true`. */
export function isMtResolutionV2Enabled(env: MtEnv = process.env): boolean {
  return env.MT_RESOLUTION_V2 === 'true';
}

/**
 * True only when the env master is on AND the tenant's
 * `feature_flags.mt.jobs_tenant_loop` is truthy.
 */
export function isJobsTenantLoopEnabled(
  env: MtEnv = process.env,
  settings: MtTenantSettings | null | undefined,
): boolean {
  if (!isMtResolutionV2Enabled(env)) return false;
  const flags = settings?.feature_flags;
  if (!flags || typeof flags !== 'object') return false;
  const mt = (flags as Record<string, unknown>).mt;
  if (!mt || typeof mt !== 'object') return false;
  return Boolean((mt as Record<string, unknown>).jobs_tenant_loop);
}
