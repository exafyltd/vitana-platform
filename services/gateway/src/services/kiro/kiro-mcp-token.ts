/**
 * VTID-05005: the pass a Kiro session uses to call the Operator's developer
 * tools (POST /api/v1/operator/kiro/mcp).
 *
 * A signed, self-contained token so it verifies on whichever gateway task the
 * ALB picks (stickiness is off; during a deploy two tasks serve). The key is
 * derived from the environment's existing GATEWAY_INTERNAL_TOKEN with its own
 * HKDF salt/info (the same pattern as VTID-05002's cross-task-forward.ts), so
 * nothing new is provisioned and staging and production keys differ.
 *
 *   token = base64url(JSON {u, t, e, x}) + "." + base64url(HMAC-SHA256)
 *
 * u = user id, t = thread id, e = environment, x = expiry (ms). At most 1 h.
 * The token grants read tools only, as that user, and the route re-checks the
 * user's exafy_admin flag on every call.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'crypto';

export const KIRO_MCP_TOKEN_TTL_MS = 60 * 60_000;

export interface KiroMcpClaims { userId: string; threadId: string; env: string; expiresAt: number }

export type KiroMcpTokenCheck =
  | { ok: true; claims: KiroMcpClaims }
  | { ok: false; reason: 'unconfigured' | 'malformed' | 'bad_signature' | 'expired' | 'wrong_env' };

export function isKiroMcpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KIRO_MCP_ENABLED === 'true';
}

/** The environment a token is bound to: staging and production never accept each other's. */
export function kiroMcpEnvName(env: NodeJS.ProcessEnv = process.env): string {
  return env.VITANA_ENV === 'staging' ? 'staging' : 'production';
}

function signingKey(env: NodeJS.ProcessEnv): Buffer | null {
  const secret = env.GATEWAY_INTERNAL_TOKEN ?? '';
  if (!secret) return null;
  return Buffer.from(hkdfSync('sha256', secret, 'vitana-kiro-mcp', 'kiro-mcp-token-v1', 32));
}

const b64 = (b: Buffer) => b.toString('base64url');

/** Mint a pass for one Kiro session. null when the gateway cannot sign (then Kiro gets no tools). */
export function mintKiroMcpToken(
  userId: string,
  threadId: string,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): string | null {
  const key = signingKey(env);
  if (!key || !userId || !threadId) return null;
  const body = b64(Buffer.from(JSON.stringify({ u: userId, t: threadId, e: kiroMcpEnvName(env), x: now + KIRO_MCP_TOKEN_TTL_MS })));
  return `${body}.${b64(createHmac('sha256', key).update(body).digest())}`;
}

export function verifyKiroMcpToken(token: string, env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): KiroMcpTokenCheck {
  const key = signingKey(env);
  if (!key) return { ok: false, reason: 'unconfigured' };
  if (typeof token !== 'string' || token.length > 2048) return { ok: false, reason: 'malformed' };
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return { ok: false, reason: 'malformed' };
  const body = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1), 'base64url');
  const want = createHmac('sha256', key).update(body).digest();
  if (sig.length !== want.length || !timingSafeEqual(sig, want)) return { ok: false, reason: 'bad_signature' };
  let c: { u?: unknown; t?: unknown; e?: unknown; x?: unknown };
  try { c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'malformed' }; }
  if (typeof c.u !== 'string' || typeof c.t !== 'string' || typeof c.e !== 'string' || typeof c.x !== 'number') return { ok: false, reason: 'malformed' };
  if (c.e !== kiroMcpEnvName(env)) return { ok: false, reason: 'wrong_env' };
  if (c.x <= now) return { ok: false, reason: 'expired' };
  return { ok: true, claims: { userId: c.u, threadId: c.t, env: c.e, expiresAt: c.x } };
}
