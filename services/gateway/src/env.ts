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

/**
 * VTID-04220: the base URL of THIS environment's gateway, for code that must
 * probe or call the gateway it is running as (the verifying-stage /alive
 * probe in dev-autopilot-execute.ts, the self-healing endpoint probe).
 *
 * `GATEWAY_URL` wins when set. Otherwise the default follows VITANA_ENV:
 * staging → preview-aws-gateway, production → gateway. Before this the two
 * call sites carried their own literals — the reconciler's was the deleted
 * GCP Cloud Run host (`gateway-q74ibpv6ia-uc.a.run.app`, dead since the
 * 2026-08-16 shutdown, CLAUDE.md §1), so every probe from that path failed
 * and reverted the merge; the probe helper's was production, so a staging
 * execution was verified against prod. Pure (reads the env it is given) so
 * tests do not have to reload this module.
 */
export const GATEWAY_URLS: Record<VitanaEnv, string> = {
  staging: 'https://preview-aws-gateway.vitanaland.com',
  production: 'https://gateway.vitanaland.com',
};

export function gatewayBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.GATEWAY_URL || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  return GATEWAY_URLS[env.VITANA_ENV === 'staging' ? 'staging' : 'production'];
}
