/**
 * VTID-05023 — REST base switch for the gateway.
 *
 * `DATA_REST_BASE_MODE` picks where `/rest/v1` (PostgREST) traffic goes:
 *
 *   - `supabase` (default, used when the variable is unset or empty): REST goes
 *     to `SUPABASE_URL`. Nothing is installed; behaviour is unchanged.
 *   - `aurora_proxy`: REST goes to `DATA_REST_PROXY_URL`, the PostgREST-Aurora
 *     proxy. Only URLs that begin with `${SUPABASE_URL}/rest/v1` are rewritten.
 *
 * AUTH never changes. `/auth/v1`, token verification and any use of
 * `SUPABASE_JWT_SECRET` or `SUPABASE_ANON_KEY` keep `SUPABASE_URL` in both modes.
 *
 * The gateway builds REST URLs from `SUPABASE_URL` at about a thousand call
 * sites, so the switch is applied once at boot by wrapping `globalThis.fetch`.
 *
 * Unknown values throw at boot. The process then does not start, and the
 * deploy's smoke check rolls back. This fails closed rather than sending
 * traffic to an unintended backend.
 */

export type DataRestBaseMode = 'supabase' | 'aurora_proxy';

export const DATA_REST_BASE_MODE_ENV = 'DATA_REST_BASE_MODE';
export const DATA_REST_PROXY_URL_ENV = 'DATA_REST_PROXY_URL';

const WRAPPED = Symbol.for('vitana.data-rest-base.wrapped');

function trimmed(value: string | undefined): string {
  return (value || '').trim();
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function getDataRestBaseMode(env: NodeJS.ProcessEnv = process.env): DataRestBaseMode {
  const raw = trimmed(env[DATA_REST_BASE_MODE_ENV]);
  if (raw === '') return 'supabase';
  if (raw === 'supabase' || raw === 'aurora_proxy') return raw;
  throw new Error(
    `[DataRestBase] Unknown ${DATA_REST_BASE_MODE_ENV} "${raw}". Allowed values: supabase, aurora_proxy.`
  );
}

/** The Supabase base URL for AUTH. Same value in every mode. */
export function getSupabaseAuthBase(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const url = trimmed(env.SUPABASE_URL);
  return url ? stripTrailingSlash(url) : undefined;
}

function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * The proxy receives the Supabase service role key on every REST call, so its
 * host must be internal: a host ending in `.internal` (this includes
 * `.vitana.internal`), or a private IPv4 literal (10/8, 172.16/12, 192.168/16, 127/8).
 */
function assertInternalProxyUrl(proxy: string): void {
  let url: URL;
  try {
    url = new URL(proxy);
  } catch {
    throw new Error(`[DataRestBase] ${DATA_REST_PROXY_URL_ENV} is not a valid URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`[DataRestBase] ${DATA_REST_PROXY_URL_ENV} must use http or https.`);
  }
  const host = url.hostname.toLowerCase();
  if (host.endsWith('.internal') || isPrivateIPv4(host)) return;
  throw new Error(
    `[DataRestBase] ${DATA_REST_PROXY_URL_ENV} host "${host}" is not an internal host. ` +
      'Use a host ending in .internal or .vitana.internal, or a private IP (10.x, 172.16-31.x, 192.168.x, 127.x).'
  );
}

/** The base that `/rest/v1` requests go to for the current mode. */
export function getDataRestBase(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (getDataRestBaseMode(env) === 'supabase') return getSupabaseAuthBase(env);
  const proxy = trimmed(env[DATA_REST_PROXY_URL_ENV]);
  if (!proxy) {
    throw new Error(
      `[DataRestBase] ${DATA_REST_BASE_MODE_ENV}=aurora_proxy requires ${DATA_REST_PROXY_URL_ENV} to be set.`
    );
  }
  assertInternalProxyUrl(proxy);
  return stripTrailingSlash(proxy);
}

/**
 * Rewrites a request URL from the Supabase REST prefix to the REST base.
 * Anything else, including every `/auth/v1` URL, is returned unchanged.
 */
export function rewriteRestUrl(url: string, env: NodeJS.ProcessEnv = process.env): string {
  if (getDataRestBaseMode(env) === 'supabase') return url;
  const supabase = getSupabaseAuthBase(env);
  if (!supabase) return url;
  const from = `${supabase}/rest/v1`;
  if (url !== from && !url.startsWith(`${from}/`) && !url.startsWith(`${from}?`)) return url;
  const to = `${getDataRestBase(env)}/rest/v1`;
  return `${to}${url.slice(from.length)}`;
}

/**
 * Installs the REST routing wrapper on `globalThis.fetch`. Call once at boot.
 * In `supabase` mode this returns without touching `fetch`.
 */
export function installDataRestRouting(env: NodeJS.ProcessEnv = process.env): DataRestBaseMode {
  const mode = getDataRestBaseMode(env);
  if (mode === 'supabase') return mode;

  // Fail at boot, not on the first request, if the proxy URL is missing.
  getDataRestBase(env);

  const original = globalThis.fetch as typeof fetch & { [WRAPPED]?: true };
  if (original[WRAPPED]) return mode;

  const wrapped = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (typeof input === 'string') {
      return original(rewriteRestUrl(input, env), init);
    }
    if (input instanceof URL) {
      const rewritten = rewriteRestUrl(input.toString(), env);
      return original(rewritten === input.toString() ? input : rewritten, init);
    }
    const rewritten = rewriteRestUrl(input.url, env);
    if (rewritten === input.url) return original(input, init);
    return original(new Request(rewritten, input), init);
  }) as typeof fetch & { [WRAPPED]?: true };
  wrapped[WRAPPED] = true;
  globalThis.fetch = wrapped;
  return mode;
}
