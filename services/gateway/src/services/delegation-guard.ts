/**
 * VTID-04968 — AI delegated credentials operate Vitanaland only through the
 * reviewed MCP tool surface.
 *
 * Owner decision 2026-10-08 (ChatGPT plugin plan, Gate 1): a Supabase access
 * token issued to an OAuth client (Claude, ChatGPT, …) is a full user JWT, and
 * every gateway route accepts it. This guard keeps such a token on `/mcp` and
 * the discovery documents; it never becomes a general-purpose REST credential.
 *
 *   delegated  → only `/mcp`, `/.well-known/*`, `/alive`, `/health`; else 403.
 *   unknown    → fail closed for anything that is not a GET (reads survive a
 *                lookup outage); `DELEGATION_GUARD_UNKNOWN=allow` is the switch.
 *   direct     → untouched.
 *
 * Classification uses the same two checks as `requestDelegation()` (the token's
 * `client_id` claim, then the session in `auth.sessions`), the second one cached
 * per session for a minute. The token is decoded WITHOUT verifying its
 * signature: the guard can only ever restrict. A forged token fails the route's
 * own verification, and a real delegated token cannot shed its `client_id`
 * without breaking its signature.
 *
 * Only tokens issued by this project's Supabase Auth to `authenticated` users
 * are looked up. Anything else (service tokens, Cognito, the community
 * project's tokens) cannot come from our OAuth server and passes unchanged.
 *
 * Switches: DELEGATION_GUARD=enforce|log|off (default enforce).
 */
import type { NextFunction, Request, Response } from 'express';
import * as jose from 'jose';
import { getSupabase } from '../lib/supabase';
import { emitOasisEvent } from './oasis-event-service';

export type SessionVerdict = 'direct' | 'delegated' | 'unknown';
type Rpc = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> };

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 5_000;
const sessionCache = new Map<string, { verdict: SessionVerdict; expires: number }>();

/** Paths a delegated token may reach. */
export function isDelegatedPathAllowed(path: string): boolean {
  return (
    path === '/mcp' ||
    path.startsWith('/mcp/') ||
    path === '/.well-known' ||
    path.startsWith('/.well-known/') ||
    path === '/alive' ||
    path === '/health'
  );
}

export function guardMode(env: NodeJS.ProcessEnv = process.env): 'enforce' | 'log' | 'off' {
  const v = (env.DELEGATION_GUARD ?? '').trim().toLowerCase();
  return v === 'off' || v === 'log' ? v : 'enforce';
}

function ownIssuer(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = env.SUPABASE_URL?.replace(/\/+$/, '');
  return base ? `${base}/auth/v1` : null;
}

/**
 * Session lookup with a short cache. On a lookup error the last known verdict
 * for that session is reused (a session never turns from delegated to direct);
 * with none, the answer is 'unknown'.
 */
export async function sessionVerdict(s: Rpc | null, sessionId: string, now = Date.now()): Promise<SessionVerdict> {
  const hit = sessionCache.get(sessionId);
  if (hit && hit.expires > now) return hit.verdict;
  if (!s) return hit?.verdict ?? 'unknown';
  try {
    const { data, error } = await s.rpc('auth_session_is_delegated', { p_session_id: sessionId });
    if (error) return hit?.verdict ?? 'unknown';
    const verdict: SessionVerdict = data === 'direct' ? 'direct' : data === 'delegated' ? 'delegated' : 'unknown';
    if (verdict !== 'unknown') {
      if (sessionCache.size >= CACHE_MAX) sessionCache.clear();
      sessionCache.set(sessionId, { verdict, expires: now + CACHE_TTL_MS });
    }
    return verdict;
  } catch {
    return hit?.verdict ?? 'unknown';
  }
}

export function resetDelegationCache(): void {
  sessionCache.clear();
  blockLog.clear();
}

/**
 * Classify a bearer token. `skip` = not a token this guard has anything to say
 * about (not ours, or not a user session).
 */
export async function classifyBearer(
  token: string,
  s: Rpc | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ verdict: SessionVerdict | 'skip'; claims: jose.JWTPayload | null }> {
  let claims: jose.JWTPayload;
  try {
    claims = jose.decodeJwt(token);
  } catch {
    return { verdict: 'skip', claims: null };
  }
  if (claims.client_id !== undefined && claims.client_id !== null) return { verdict: 'delegated', claims };
  const issuer = ownIssuer(env);
  if (!issuer || claims.iss !== issuer || claims.role !== 'authenticated') return { verdict: 'skip', claims };
  const sessionId = typeof claims.session_id === 'string' ? claims.session_id : null;
  if (!sessionId) return { verdict: 'unknown', claims };
  return { verdict: await sessionVerdict(s, sessionId), claims };
}

/** One audit event per user per minute per outcome, so a probe cannot flood OASIS. */
const blockLog = new Map<string, number>();
function shouldLog(key: string, now = Date.now()): boolean {
  const last = blockLog.get(key) ?? 0;
  if (now - last < 60_000) return false;
  if (blockLog.size > 5_000) blockLog.clear();
  blockLog.set(key, now);
  return true;
}

async function audit(
  outcome: 'blocked' | 'would_block',
  verdict: SessionVerdict,
  claims: jose.JWTPayload | null,
  req: Request,
): Promise<void> {
  const userId = typeof claims?.sub === 'string' ? claims.sub : null;
  if (!shouldLog(`${userId ?? 'anon'}:${verdict}:${outcome}`)) return;
  await emitOasisEvent({
    vtid: 'VTID-04968',
    type: 'commerce.mcp.delegated_token_blocked',
    source: 'delegation-guard',
    status: 'warning',
    message: `Delegated credential ${outcome}: ${req.method} ${req.path} (${verdict}).`,
    payload: {
      outcome,
      verdict,
      method: req.method,
      path: req.path,
      client_id: typeof claims?.client_id === 'string' ? claims.client_id : null,
    },
    actor_id: userId ?? undefined,
    actor_role: 'agent',
    surface: 'api',
  }).catch(() => undefined);
}

/** Express middleware; mount after the body parsers and before every router. */
export function delegatedTokenGuard(env: NodeJS.ProcessEnv = process.env) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const mode = guardMode(env);
    if (mode === 'off' || req.method === 'OPTIONS') return next();
    const header = req.get('authorization') ?? '';
    if (!header.toLowerCase().startsWith('bearer ')) return next();
    const token = header.slice(7).trim();
    if (!token) return next();

    const { verdict, claims } = await classifyBearer(token, getSupabase() as unknown as Rpc | null, env);
    if (verdict === 'skip' || verdict === 'direct') return next();

    let block = false;
    if (verdict === 'delegated') block = !isDelegatedPathAllowed(req.path);
    else if (verdict === 'unknown') block = req.method !== 'GET' && env.DELEGATION_GUARD_UNKNOWN !== 'allow';
    if (!block) return next();

    await audit(mode === 'enforce' ? 'blocked' : 'would_block', verdict, claims, req);
    if (mode === 'log') return next();
    return res.status(403).json({
      ok: false,
      error: verdict === 'delegated' ? 'DELEGATED_TOKEN_NOT_ALLOWED' : 'SESSION_ORIGIN_UNKNOWN',
      message:
        verdict === 'delegated'
          ? 'An AI assistant credential can only use the Vitanaland MCP tools.'
          : 'The origin of this session could not be established.',
    });
  };
}
