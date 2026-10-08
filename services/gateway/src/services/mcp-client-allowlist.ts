/**
 * VTID-04968 — which AI assistants may use the Commerce MCP.
 *
 * Supabase's OAuth server registers clients dynamically (Claude depends on
 * it), so a client_id is minted per connection and cannot be listed. What
 * identifies an assistant is where its authorization code is delivered: the
 * hosts of the redirect URIs it registered. A delegated token reaches `/mcp`
 * only when EVERY registered redirect URI is https on an approved host.
 * Unknown client, lookup failure, no approved host: refused (fail closed).
 *
 * COMMERCE_MCP_ALLOWED_REDIRECT_HOSTS: comma list, matched as the host or any
 * subdomain of it. Default: chatgpt.com, chat.openai.com, claude.ai, claude.com.
 */
import type * as jose from 'jose';
import { sessionVerdict, type SessionVerdict } from './delegation-guard';

type Rpc = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> };

export const DEFAULT_ALLOWED_REDIRECT_HOSTS = ['chatgpt.com', 'chat.openai.com', 'claude.ai', 'claude.com'] as const;

export function allowedRedirectHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = (env.COMMERCE_MCP_ALLOWED_REDIRECT_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return configured.length ? configured : [...DEFAULT_ALLOWED_REDIRECT_HOSTS];
}

/** Redirect URIs as stored by Supabase: a JSON array or a delimited string. */
export function parseRedirectUris(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string');
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[\s,;"'[\]{}]+/)
    .map((p) => p.trim())
    .filter((p) => /^[a-z][a-z0-9+.-]*:\/\//i.test(p));
}

export function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((a) => h === a || h.endsWith(`.${a}`));
}

export function redirectUrisAllowed(uris: string[], allowed: string[]): boolean {
  if (uris.length === 0) return false;
  return uris.every((u) => {
    try {
      const url = new URL(u);
      return url.protocol === 'https:' && hostAllowed(url.hostname, allowed);
    } catch {
      return false;
    }
  });
}

const CLIENT_TTL_MS = 5 * 60_000;
const clientCache = new Map<string, { uris: string[]; name: string | null; expires: number }>();
export function resetClientCache(): void {
  clientCache.clear();
}

export type ClientCheck =
  | { ok: true; clientId: string | null; clientName: string | null; delegated: boolean }
  | { ok: false; reason: 'client_unidentified' | 'client_unknown' | 'client_not_approved' | 'session_origin_unknown' };

/**
 * `claims` come from a token the caller already verified. A token with no
 * client_id is the user's own session (allowed, as before) unless the session
 * lookup says it is delegated or cannot tell — then there is no client to
 * approve and it is refused.
 */
export async function checkMcpClient(
  s: (Rpc & object) | null,
  claims: jose.JWTPayload | undefined,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): Promise<ClientCheck> {
  const clientId = typeof claims?.client_id === 'string' ? claims.client_id : null;
  if (!clientId) {
    const sessionId = typeof claims?.session_id === 'string' ? claims.session_id : null;
    const verdict: SessionVerdict = sessionId ? await sessionVerdict(s, sessionId, now) : 'unknown';
    if (verdict === 'direct') return { ok: true, clientId: null, clientName: null, delegated: false };
    return { ok: false, reason: verdict === 'delegated' ? 'client_unidentified' : 'session_origin_unknown' };
  }

  let info = clientCache.get(clientId);
  if (!info || info.expires <= now) {
    if (!s) return { ok: false, reason: 'client_unknown' };
    try {
      const { data, error } = await s.rpc('mcp_oauth_client_info', { p_client_id: clientId });
      const row = data as { client_name?: unknown; redirect_uris?: unknown } | null;
      if (error || !row) return { ok: false, reason: 'client_unknown' };
      info = {
        uris: parseRedirectUris(row.redirect_uris),
        name: typeof row.client_name === 'string' ? row.client_name : null,
        expires: now + CLIENT_TTL_MS,
      };
      clientCache.set(clientId, info);
    } catch {
      return { ok: false, reason: 'client_unknown' };
    }
  }
  if (!redirectUrisAllowed(info.uris, allowedRedirectHosts(env))) return { ok: false, reason: 'client_not_approved' };
  return { ok: true, clientId, clientName: info.name, delegated: true };
}
