/**
 * VTID-05068 (Phase 3 of the sparred "Kiro on one server-side run record" plan):
 * the token a gateway task presents to the kiro-runner to take over a Kiro
 * session whose gateway socket dropped (a deploy, a crash).
 *
 * Why derived, not stored: the task that reattaches is a DIFFERENT process from
 * the one that opened the session, so it must be able to produce the token,
 * yet the token itself must never be stored (sparring finding F7: stored
 * hashed, valid only inside the reattach window). So:
 *
 *   nonce = 16 random bytes per Kiro session (base64url)
 *   token = base64url(HMAC-SHA256(K, "kiro-reattach:" + nonce))
 *   K     = HKDF(GATEWAY_INTERNAL_TOKEN, own salt/info) — the same derivation
 *           pattern as kiro-mcp-token.ts; nothing new to provision, staging and
 *           production keys differ.
 *
 * The run row keeps the nonce, sha256(token) and the window's end. A database
 * reader alone cannot present the token (it needs the gateway's secret); the
 * runner keeps only sha256(token) too. The token travels only in the
 * `X-Kiro-Reattach-Token` header (never a URL, never a log line).
 */
import { createHash, createHmac, hkdfSync, randomBytes } from 'crypto';

/** Same default as the runner's KIRO_RUNNER_REATTACH_MS: how long a dropped session waits. */
export const KIRO_REATTACH_DEFAULT_MS = 10 * 60_000;

export function kiroReattachWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  if (env.KIRO_RUNNER_REATTACH_MS === '0') return 0;
  const n = Number.parseInt(env.KIRO_RUNNER_REATTACH_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : KIRO_REATTACH_DEFAULT_MS;
}

function reattachKey(env: NodeJS.ProcessEnv): Buffer | null {
  const secret = env.GATEWAY_INTERNAL_TOKEN ?? '';
  if (!secret) return null;
  return Buffer.from(hkdfSync('sha256', secret, 'vitana-kiro-reattach', 'kiro-reattach-token-v1', 32));
}

/** Reattach is possible on this deployment: a signing secret and a non-zero window. */
export function isKiroReattachConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return reattachKey(env) !== null && kiroReattachWindowMs(env) > 0;
}

export function newKiroReattachNonce(): string { return randomBytes(16).toString('base64url'); }

/** The token for a session nonce; null when the gateway cannot sign (then the session is not reattachable). */
export function kiroReattachToken(nonce: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const key = reattachKey(env);
  if (!key || typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return null;
  return createHmac('sha256', key).update(`kiro-reattach:${nonce}`).digest('base64url');
}

/** What the run row stores (hex sha256), and what the runner keeps (raw sha256). */
export function hashKiroReattachToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** The session's reattach identity as the run record keeps it: never the token. */
export interface KiroReattachRecord { nonce: string; tokenHash: string }
