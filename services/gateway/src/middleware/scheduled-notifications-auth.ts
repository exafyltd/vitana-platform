/**
 * VTID-04677 — auth for /api/v1/scheduled-notifications/*.
 *
 * Every POST under this router fans out notifications (often a push to every
 * member of a tenant), and until now each one accepted anonymous requests from
 * the public internet. The routes used to rely on GCP IAM at the Cloud
 * Scheduler layer; GCP is gone, so nothing protected them.
 *
 * Only machine callers use these routes — the EventBridge-driven Lambdas
 * (vitana-push-dispatch, vitana-daily-feature-tip, vitana-whats-new,
 * vitana-cron-dispatch) and the gateway's own automation handlers. They all
 * present `X-Gateway-Internal: <GATEWAY_INTERNAL_TOKEN>`. There is deliberately
 * NO exafy_admin JWT path: no human calls these routes (Admin › Notifications
 * "Send" has its own admin route), and an admin session should not be able to
 * fire a tenant-wide push by hand.
 *
 * `GET /health` stays open (ECS health checks, the Command Hub dependency
 * probe) and reports the resolved mode so staging can prove what is deployed.
 *
 * Rollout switch `SCHEDULED_NOTIFICATIONS_AUTH_MODE` (same semantics as
 * LEDGER_WRITE_AUTH_MODE, VTID-04727):
 *   - `enforce` — reject with 401/403 (fail closed; 503 if the token is unset).
 *   - `off`     — no check at all (emergency rollback only).
 *   - anything else, including unset — `log`: run the same check, log every
 *     request that WOULD be rejected, and let it through. The log lines are
 *     the list of callers still to fix before flipping to `enforce`.
 *
 * The compare is timing-safe. That is an improvement over the plain `===` the
 * other X-Gateway-Internal checks in this codebase use, not a copy of them.
 */
import { timingSafeEqual } from 'crypto';
import { Request, Response, NextFunction } from 'express';

export type ScheduledNotificationsAuthMode = 'enforce' | 'log' | 'off';

export const INTERNAL_TOKEN_HEADER = 'X-Gateway-Internal';

export interface ScheduledNotificationsAuthResult {
  ok: boolean;
  status?: 401 | 403 | 503;
  error?: string;
}

export function resolveScheduledNotificationsAuthMode(
  raw = process.env.SCHEDULED_NOTIFICATIONS_AUTH_MODE,
): ScheduledNotificationsAuthMode {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'enforce') return 'enforce';
  if (v === 'off') return 'off';
  return 'log';
}

function configuredToken(): string {
  return (process.env.GATEWAY_INTERNAL_TOKEN ?? '').trim();
}

/** Constant-time compare; false for any length mismatch or empty side. */
export function tokensMatch(presented: string, expected: string): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Routes that stay open in every mode. */
export function isOpenScheduledNotificationsPath(req: Pick<Request, 'method' | 'path'>): boolean {
  return req.method === 'GET' && req.path === '/health';
}

/** The check itself, without responding — shared by all modes. */
export function evaluateScheduledNotificationsAuth(req: Request): ScheduledNotificationsAuthResult {
  const expected = configuredToken();
  if (!expected) return { ok: false, status: 503, error: 'internal token not configured' };
  const presented = String(req.get(INTERNAL_TOKEN_HEADER) ?? '').trim();
  if (!presented) return { ok: false, status: 401, error: 'missing internal token' };
  if (!tokensMatch(presented, expected)) return { ok: false, status: 403, error: 'invalid internal token' };
  return { ok: true };
}

export function requireScheduledNotificationsAuth(req: Request, res: Response, next: NextFunction): void {
  if (isOpenScheduledNotificationsPath(req)) {
    next();
    return;
  }
  const mode = resolveScheduledNotificationsAuthMode();
  if (mode === 'off') {
    next();
    return;
  }
  const result = evaluateScheduledNotificationsAuth(req);
  if (result.ok) {
    next();
    return;
  }
  if (mode === 'enforce') {
    if (result.status === 503) {
      console.error('[VTID-04677] GATEWAY_INTERNAL_TOKEN is not set — scheduled-notifications refuses every call in enforce mode');
    }
    res.status(result.status ?? 401).json({ ok: false, error: result.error });
    return;
  }
  // Never log the header value — only that it was missing or wrong.
  console.warn(
    `[VTID-04677] scheduled-notifications call would be rejected (mode=log): ${req.method} ${req.originalUrl || req.url} ` +
      `status=${result.status} reason="${result.error}" ip=${req.ip ?? '-'} ua="${String(req.get('user-agent') ?? '').slice(0, 80)}"`,
  );
  next();
}

/** What GET /health reports — booleans and the mode only, never the token. */
export function scheduledNotificationsAuthStatus(): { auth_mode: ScheduledNotificationsAuthMode; internal_token_configured: boolean } {
  return { auth_mode: resolveScheduledNotificationsAuthMode(), internal_token_configured: configuredToken().length > 0 };
}

/** Header for the gateway's own calls to these routes; empty when no token is configured. */
export function internalTokenHeaders(): Record<string, string> {
  const token = configuredToken();
  return token ? { [INTERNAL_TOKEN_HEADER]: token } : {};
}
