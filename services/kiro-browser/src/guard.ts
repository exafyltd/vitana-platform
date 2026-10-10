/**
 * VTID-05070: the read-only network guard of the kiro-browser sidecar.
 *
 * The first four rules below are the STAGING-VERIFY guard's rules, byte for byte
 * (scripts/ci/staging-verify/staging-guard.ts — test/guard.test.ts fails when they drift):
 *   - every request to a production host is aborted;
 *   - every non-read request to a gateway or Supabase is aborted, except the
 *     Supabase token grant (the E2E test user's password sign-in).
 * The sidecar adds, because nobody reviews a screenshot run the way a spec is reviewed:
 *   - every non-read request to ANY host is aborted (same sign-in exception, on Supabase only);
 *   - a navigation (any frame) to a host that is not an allowlisted staging host is aborted,
 *     so a redirect, a meta refresh, window.location or a clicked link cannot leave staging.
 * The guard runs as browserContext.route('**\/*'), i.e. at the network level for every
 * request the page makes, not only for the first URL.
 */

// ---- the staging-guard.ts rules (verbatim) ---------------------------------------------
export const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Where data lives: every gateway (staging, production, DR) and Supabase.
export const GUARDED_HOST = /(^|\.)supabase\.co$|gateway\.vitanaland\.com$/;
// Mirror of PRODUCTION_HOSTS in lib.cjs.
export const PRODUCTION_HOST = /^(vitanaland\.com|www\.vitanaland\.com|gateway\.vitanaland\.com|dr-app\.vitanaland\.com|dr-gateway\.vitanaland\.com)$/;
export const ALWAYS_ALLOWED_WRITES = [/\/auth\/v1\/token(\?|$)/];

// ---- sidecar additions ---------------------------------------------------------------------
/** The hosts PRODUCTION_HOST matches, as a list (test/guard.test.ts keeps the two equal). */
export const PRODUCTION_HOSTS = ['vitanaland.com', 'www.vitanaland.com', 'gateway.vitanaland.com', 'dr-app.vitanaland.com', 'dr-gateway.vitanaland.com'];

/**
 * Chromium's --host-resolver-rules: no production host resolves in this browser, whatever
 * asks for it (a server redirect the route handler never sees, a WebSocket, a worker).
 */
export function hostResolverRules(): string {
  return PRODUCTION_HOSTS.map((h) => `MAP ${h} ~NOTFOUND`).join(', ');
}

/** The staging hosts a screenshot may show (scripts/ci/staging-verify/lib.cjs STAGING_TARGETS). */
export const DEFAULT_STAGING_HOSTS = ['preview-aws.vitanaland.com', 'preview-aws-gateway.vitanaland.com'];
const SUPABASE_HOST = /(^|\.)supabase\.co$/;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function hostOf(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase().replace(/\.$/, ''); } catch { return null; }
}

/**
 * The allowlist: the two staging hosts plus KIRO_BROWSER_EXTRA_HOSTS (exact host names,
 * comma-separated — the per-PR preview CloudFront host lives in a secret of the frontend
 * repo, so it is configured, never guessed). A production host is never allowlisted.
 */
export function stagingHosts(extra: string | undefined = process.env.KIRO_BROWSER_EXTRA_HOSTS): Set<string> {
  const hosts = new Set(DEFAULT_STAGING_HOSTS);
  for (const raw of (extra ?? '').split(',')) {
    const h = raw.trim().toLowerCase().replace(/\.$/, '');
    if (h && HOSTNAME.test(h) && !PRODUCTION_HOST.test(h) && !GUARDED_HOST.test(h)) hosts.add(h);
  }
  return hosts;
}

export type TargetCheck = { ok: true; url: string } | { ok: false; error: string };

/** The URL Kiro asked for: https, a staging host, no credentials in it. */
export function checkTargetUrl(raw: unknown, hosts: Set<string>): TargetCheck {
  if (typeof raw !== 'string' || raw.length > 2048) return { ok: false, error: 'url must be a string of at most 2048 characters' };
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, error: 'url is not a valid URL' }; }
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (PRODUCTION_HOST.test(host)) return { ok: false, error: `refusing production host ${host}: screenshots are taken on staging only` };
  if (u.protocol !== 'https:') return { ok: false, error: 'url must be https' };
  if (u.username || u.password) return { ok: false, error: 'url must not carry credentials' };
  if (u.port && u.port !== '443') return { ok: false, error: 'url must use the default https port' };
  if (!hosts.has(host)) return { ok: false, error: `host ${host} is not a staging host (allowed: ${[...hosts].join(', ')})` };
  return { ok: true, url: u.toString() };
}

export interface GuardRequest { method: string; url: string; isNavigation: boolean }
export type GuardDecision = { allow: true } | { allow: false; reason: string };

/** One request the page makes. Pure: the route handler only applies the answer. */
export function decide(req: GuardRequest, hosts: Set<string>): GuardDecision {
  const method = req.method.toUpperCase();
  const host = hostOf(req.url);
  if (host === null) {
    // data:, blob: and about: never leave the browser.
    return /^(data|blob|about):/i.test(req.url) ? { allow: true } : { allow: false, reason: 'unparseable url' };
  }
  if (PRODUCTION_HOST.test(host)) return { allow: false, reason: 'production host' };
  if (!READ_METHODS.has(method)) {
    if (SUPABASE_HOST.test(host) && ALWAYS_ALLOWED_WRITES.some((r) => r.test(req.url))) return { allow: true };
    return { allow: false, reason: `${method} is not a read` };
  }
  if (req.isNavigation && !hosts.has(host)) return { allow: false, reason: `navigation off staging (${host})` };
  return { allow: true };
}
