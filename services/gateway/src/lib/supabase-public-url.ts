/**
 * VTID-05023 (Aurora cutover, owner decision R1(b)) — the PUBLIC Supabase base
 * URL, for every link the gateway hands to someone outside its own VPC.
 *
 * At the cutover the gateway's `SUPABASE_URL` is repointed from
 * `https://<project>.supabase.co` to the INTERNAL PostgREST-Aurora proxy (a
 * Cloud Map `http://` name, reachable only inside the VPC). That proxy serves
 * `/rest/v1` from Aurora and passes `/auth`, `/storage`, `/functions` and
 * `/realtime` through to Supabase, so server-to-server calls keep working.
 *
 * What would break is any URL the gateway BUILDS from `SUPABASE_URL` and hands
 * to a member, a browser, a third party, an email/push, an LLM prompt, or
 * stores in a database row: storage public URLs, storage signed URLs, the
 * Supabase URL returned to the Command Hub by `GET /auth/config`, the
 * Command Hub CSP `img-src`. Those must carry the PUBLIC origin, never the
 * internal one. Every such site goes through this module.
 *
 * `SUPABASE_PUBLIC_URL` is the public base. When unset it defaults to
 * `SUPABASE_URL` — today the two are identical, so this is a zero-behaviour
 * change until the cutover sets `SUPABASE_PUBLIC_URL` explicitly.
 *
 * Both values are read at call time (not module load) so a test, or a
 * runtime env change, is picked up without re-importing.
 *
 * Do NOT use this for server-to-server calls: those must keep going to
 * `SUPABASE_URL` (the internal proxy after the cutover).
 */

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * The public Supabase base URL (no trailing slash): `SUPABASE_PUBLIC_URL`,
 * falling back to `SUPABASE_URL`. `undefined` when neither is set.
 */
export function getSupabasePublicUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = (env.SUPABASE_PUBLIC_URL || '').trim();
  if (explicit) return stripTrailingSlash(explicit);
  const internal = (env.SUPABASE_URL || '').trim();
  return internal ? stripTrailingSlash(internal) : undefined;
}

/**
 * The public Supabase origin (scheme + host + port), or `null` when no valid
 * base is configured. For CSP sources and other origin-only uses.
 */
export function getSupabasePublicOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  return originOf(getSupabasePublicUrl(env));
}

/**
 * Rewrites `url` onto the public Supabase origin when — and only when — its
 * origin equals the current `SUPABASE_URL` origin. Path, query (including a
 * signed URL's `token`) and fragment are preserved byte for byte. Any other
 * URL (S3, a CDN, a relative path, an unparseable string, an empty value) is
 * returned untouched. A no-op while `SUPABASE_PUBLIC_URL` is unset.
 */
export function toPublicSupabaseUrl(url: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!url) return url;
  const internalOrigin = originOf(env.SUPABASE_URL);
  const publicOrigin = getSupabasePublicOrigin(env);
  if (!internalOrigin || !publicOrigin || internalOrigin === publicOrigin) return url;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.origin !== internalOrigin) return url;

  // Swap only the origin; keep the original remainder exactly as given
  // (new URL() would re-encode some characters in path/query).
  const authorityStart = url.indexOf('//') + 2;
  const tail = url.slice(authorityStart).search(/[/?#]/);
  const rest = tail === -1 ? '' : url.slice(authorityStart + tail);
  return `${publicOrigin}${rest}`;
}
