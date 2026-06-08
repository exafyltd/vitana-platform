/**
 * VITANA_ENV — single source of truth for environment identity.
 *
 * Phase 0 staging build (handoff brief P0.3).
 *
 * Set VITANA_ENV=staging on gateway-staging Cloud Run; left unset (or
 * 'production') on gateway. Every code path that needs to vary by environment
 * (feature flags, OASIS event tagging, /admin/health response) reads from here
 * — never directly from process.env, so test code can rewrite once and the
 * whole module tree picks it up.
 */

export type VitanaEnv = 'production' | 'staging';

function resolveEnv(): VitanaEnv {
  return process.env.VITANA_ENV === 'staging' ? 'staging' : 'production';
}

export const VITANA_ENV: VitanaEnv = resolveEnv();
export const isStaging = VITANA_ENV === 'staging';
export const isProduction = VITANA_ENV === 'production';

/**
 * Derive the Supabase host from SUPABASE_URL for the /admin/health response.
 * Returns the hostname only (no scheme, no path) so staging vs prod isolation
 * is trivially visible — staging branch URLs differ from production URL.
 * Returns null if SUPABASE_URL is unset or malformed.
 */
export function supabaseHost(): string | null {
  const url = process.env.SUPABASE_URL;
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Cloud Run revision serving this request. K_REVISION is injected by Cloud Run
 * on every container; null in local dev.
 */
export function cloudRunRevision(): string | null {
  return process.env.K_REVISION ?? null;
}

/**
 * Cloud Run service name (gateway / gateway-staging / etc.). K_SERVICE is
 * injected by Cloud Run.
 */
export function cloudRunService(): string | null {
  return process.env.K_SERVICE ?? null;
}
