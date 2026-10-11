/**
 * VTID-05063 — auth for the VTID ledger's READ routes.
 *
 * VTID-04727 gated the ledger's writes; the reads (task lists, the VTID
 * projection, the board, the approvals queue) still answered anonymous
 * requests from the public internet with full ledger rows. This gate applies
 * the SAME credential rule as the write gate, by calling its
 * `evaluateLedgerWriteAuth()` so the two can never drift: the caller presents
 * EITHER `Authorization: Bearer <GATEWAY_SERVICE_TOKEN>` (CI, the gateway's own
 * self-calls) OR a validated `exafy_admin` JWT (the Command Hub).
 *   - no / empty / non-Bearer header, or a bad token → 401
 *   - a valid JWT without `exafy_admin`               → 403
 *   - a verifier crash                                → 401 (fail closed)
 *
 * Rollout switch `LEDGER_READ_AUTH_MODE` (separate from the write switch: the
 * reads have far more callers, so they flip and roll back on their own):
 *   - `enforce` — reject with 401/403.
 *   - `off`     — no check at all (emergency rollback only).
 *   - anything else, including unset — `log`: run the same check, let the
 *     request through, and log the requests that WOULD be rejected. Those
 *     lines are the list of callers still to fix before `enforce`.
 *
 * The gate is attached per route, never with `router.use` (VTID-04530: a
 * router-level gate swallowed a sibling router mounted under the same prefix),
 * so health and build-info routes on the same routers stay open.
 *
 * Log hygiene: every attacker-controlled field (User-Agent, Origin/Referer) is
 * sanitised; lines are deduplicated per route + reason + origin host + first
 * 40 UA chars over 60 s (later hits are counted and reported as
 * `suppressed=<n>` on the next line for that key); at most 200 dedupe keys
 * (oldest evicted) and 120 lines per minute per process, after which one
 * `log cap reached` line is written per minute. No token or query value is
 * ever logged.
 */
import { Request, Response, NextFunction } from 'express';
import { evaluateLedgerWriteAuth, LedgerWriteAuthResult } from './ledger-write-auth';

export type LedgerReadAuthMode = 'enforce' | 'log' | 'off';

interface LedgerReadActorRequest extends Request {
  __ledger_read_actor?: string;
}

export const LEDGER_READ_LOG_DEDUPE_WINDOW_MS = 60_000;
export const LEDGER_READ_LOG_MAX_KEYS = 200;
export const LEDGER_READ_LOG_MAX_LINES_PER_MINUTE = 120;

export function resolveLedgerReadAuthMode(raw = process.env.LEDGER_READ_AUTH_MODE): LedgerReadAuthMode {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'enforce') return 'enforce';
  if (v === 'off') return 'off';
  return 'log';
}

/** Printable ASCII only; quotes and backslashes become `?` so a field cannot break out of the line. */
export function sanitizeLogField(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(/[^\x20-\x7e]|["\\]/g, '?')
    .slice(0, max);
}

/** Host of the Origin header, else of the Referer; never the path or query. */
function originHost(req: Request): string {
  const raw = req.header('origin') || req.header('referer') || '';
  if (!raw) return '';
  try {
    return sanitizeLogField(new URL(raw).host, 100);
  } catch {
    return 'unparseable';
  }
}

/** Route template (`/api/v1/vtid/:vtid`), never the concrete path or its query string. */
function routeTemplate(req: Request): string {
  const routePath = (req as Request & { route?: { path?: unknown } }).route?.path;
  if (typeof routePath === 'string') return `${req.baseUrl || ''}${routePath}`;
  return String(req.originalUrl || req.url || '').split('?')[0];
}

// ---- log dedupe and caps (per process) ------------------------------------

const dedupe = new Map<string, { windowStart: number; suppressed: number }>();
let lineWindowStart = 0;
let linesInWindow = 0;
let capNoticeWritten = false;

function emitCapped(line: string, now: number): void {
  if (now - lineWindowStart >= LEDGER_READ_LOG_DEDUPE_WINDOW_MS) {
    lineWindowStart = now;
    linesInWindow = 0;
    capNoticeWritten = false;
  }
  if (linesInWindow >= LEDGER_READ_LOG_MAX_LINES_PER_MINUTE) {
    if (!capNoticeWritten) {
      capNoticeWritten = true;
      console.warn('[ledger-read-auth] log cap reached, dropping');
    }
    return;
  }
  linesInWindow += 1;
  console.warn(line);
}

function logWouldReject(req: Request, result: LedgerWriteAuthResult): void {
  const now = Date.now();
  const route = routeTemplate(req);
  const reason = sanitizeLogField(result.error, 80);
  const ua = sanitizeLogField(req.header('user-agent'), 80);
  const origin = originHost(req);
  const key = `${route}|${reason}|${origin}|${ua.slice(0, 40)}`;

  const entry = dedupe.get(key);
  if (entry && now - entry.windowStart < LEDGER_READ_LOG_DEDUPE_WINDOW_MS) {
    entry.suppressed += 1;
    return;
  }
  const suppressed = entry ? entry.suppressed : 0;
  dedupe.delete(key); // re-insert so Map order is least-recently-logged first
  dedupe.set(key, { windowStart: now, suppressed: 0 });
  while (dedupe.size > LEDGER_READ_LOG_MAX_KEYS) {
    const oldest = dedupe.keys().next().value as string;
    dedupe.delete(oldest);
  }

  emitCapped(
    `[VTID-05063] ledger read would be rejected (mode=log): ${req.method} ${route} ` +
      `status=${result.status} reason="${reason}" ua="${ua}" origin="${origin}"` +
      (suppressed > 0 ? ` suppressed=${suppressed}` : ''),
    now,
  );
}

/** Test seam: forget the dedupe keys and the per-minute line budget. */
export function __resetLedgerReadAuthLogState(): void {
  dedupe.clear();
  lineWindowStart = 0;
  linesInWindow = 0;
  capNoticeWritten = false;
}

/** Number of live dedupe keys (test seam for the 200-key cap). */
export function __ledgerReadAuthDedupeSize(): number {
  return dedupe.size;
}

// ---- the gate ---------------------------------------------------------------

export function requireLedgerReadAuth(req: Request, res: Response, next: NextFunction): void {
  const mode = resolveLedgerReadAuthMode();
  if (mode === 'off') {
    next();
    return;
  }
  // Two-argument then(): an error thrown by next() is never mistaken for a
  // verifier crash (which would call next() a second time).
  Promise.resolve()
    .then(() => evaluateLedgerWriteAuth(req))
    .then(
      (result) => {
        if (result.ok) {
          (req as LedgerReadActorRequest).__ledger_read_actor = result.actor;
          next();
          return;
        }
        if (mode === 'enforce') {
          res.status(result.status ?? 401).json({ ok: false, error: result.error });
          return;
        }
        logWouldReject(req, result);
        next();
      },
      (err) => {
        // A verifier crash must not open the gate in enforce mode.
        console.error('[VTID-05063] ledger read auth check failed:', err);
        if (mode === 'enforce') {
          res.status(401).json({ ok: false, error: 'authentication check failed' });
          return;
        }
        next();
      },
    );
}

/** Verified actor (`service:internal` / `admin:<user_id>`); null when not verified (log/off mode). */
export function getLedgerReadActor(req: Request): string | null {
  return (req as LedgerReadActorRequest).__ledger_read_actor ?? null;
}

/**
 * One line at boot (called from the `app.listen` callback): the mode, and
 * whether a service token is configured at all. Presence only, never the value,
 * so "enforce is on but no service token exists here" is visible at boot.
 */
export function logLedgerReadAuthBoot(): void {
  const configured = (process.env.GATEWAY_SERVICE_TOKEN ?? '').length > 0;
  console.log(`[ledger-read-auth] mode=${resolveLedgerReadAuthMode()} service_token_configured=${configured}`);
}
