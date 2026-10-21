/**
 * VTID-04727 — auth for the VTID ledger's write routes.
 *
 * Until now every route that creates, edits, deletes, closes or mints a VTID
 * (POST/PATCH/DELETE /api/v1/oasis/tasks…, POST /api/v1/oasis/tasks/:vtid/complete,
 * POST /api/v1/vtid/allocate, POST /api/v1/vtid/create) accepted anonymous
 * requests from the public internet. This gate applies the same rule as
 * `requireServiceOrAdmin` (the self-healing control-plane gate): the caller
 * presents EITHER `Authorization: Bearer <GATEWAY_SERVICE_TOKEN>` (CI and the
 * gateway's own self-calls) OR a validated `exafy_admin` JWT (the Command Hub).
 *
 * Rollout switch `LEDGER_WRITE_AUTH_MODE`:
 *   - `enforce` — reject with 401/403 (fail closed).
 *   - `off`     — no check at all (emergency rollback only).
 *   - anything else, including unset — `log`: run the same check, log every
 *     request that WOULD be rejected, and let it through. This is the default
 *     so a deploy never breaks a caller nobody knew about; the log lines are
 *     the list of callers still to fix before flipping to `enforce`.
 *
 * The verified actor (`service:internal` / `admin:<user_id>`) is attached to
 * the request so routes record who acted instead of trusting a header.
 */
import { Request, Response, NextFunction } from 'express';
import { optionalAuth, AuthenticatedRequest } from './auth-supabase-jwt';

export type LedgerWriteAuthMode = 'enforce' | 'log' | 'off';

export interface LedgerWriteAuthResult {
  ok: boolean;
  status?: 401 | 403;
  error?: string;
  actor?: string;
}

interface LedgerActorRequest extends Request {
  __ledger_write_actor?: string;
}

export function resolveLedgerWriteAuthMode(raw = process.env.LEDGER_WRITE_AUTH_MODE): LedgerWriteAuthMode {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'enforce') return 'enforce';
  if (v === 'off') return 'off';
  return 'log';
}

function extractBearer(req: Request): string | null {
  const header = req.header('authorization') ?? req.header('Authorization');
  if (!header || !header.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice('bearer '.length).trim();
  return token.length > 0 ? token : null;
}

function matchesServiceToken(token: string): boolean {
  const serviceToken = process.env.GATEWAY_SERVICE_TOKEN ?? '';
  return serviceToken.length > 0 && token === serviceToken;
}

/** The check itself, without responding — shared by all three modes. */
export async function evaluateLedgerWriteAuth(req: Request): Promise<LedgerWriteAuthResult> {
  const token = extractBearer(req);
  if (!token) return { ok: false, status: 401, error: 'missing bearer token' };
  if (matchesServiceToken(token)) return { ok: true, actor: 'service:internal' };

  await new Promise<void>((resolve, reject) => {
    // optionalAuth never responds; it only attaches req.identity when the JWT
    // verifies. A throw inside it must reach the caller, not hang the request.
    Promise.resolve(optionalAuth(req as AuthenticatedRequest, {} as Response, () => resolve())).catch(reject);
  });
  const id = (req as AuthenticatedRequest).identity;
  if (!id) return { ok: false, status: 401, error: 'invalid or expired token' };
  if (id.exafy_admin !== true) {
    return { ok: false, status: 403, error: 'forbidden — exafy_admin privileges required' };
  }
  return { ok: true, actor: `admin:${id.user_id ?? 'unknown'}` };
}

export function requireLedgerWriteAuth(req: Request, res: Response, next: NextFunction): void {
  const mode = resolveLedgerWriteAuthMode();
  if (mode === 'off') {
    next();
    return;
  }
  evaluateLedgerWriteAuth(req)
    .then((result) => {
      if (result.ok) {
        (req as LedgerActorRequest).__ledger_write_actor = result.actor;
        next();
        return;
      }
      if (mode === 'enforce') {
        res.status(result.status ?? 401).json({ ok: false, error: result.error });
        return;
      }
      console.warn(
        `[VTID-04727] ledger write would be rejected (mode=log): ${req.method} ${req.originalUrl || req.url} ` +
          `status=${result.status} reason="${result.error}" ua="${String(req.header('user-agent') ?? '').slice(0, 80)}"`,
      );
      next();
    })
    .catch((err) => {
      // A verifier crash must not open the gate in enforce mode.
      console.error('[VTID-04727] ledger write auth check failed:', err);
      if (mode === 'enforce') {
        res.status(401).json({ ok: false, error: 'authentication check failed' });
        return;
      }
      next();
    });
}

/** Verified actor for audit fields; null when the request was not verified (log/off mode). */
export function getLedgerWriteActor(req: Request): string | null {
  return (req as LedgerActorRequest).__ledger_write_actor ?? null;
}

/** Authorization header for the gateway's own calls to its ledger routes. */
export function serviceAuthHeaders(): Record<string, string> {
  const token = process.env.GATEWAY_SERVICE_TOKEN ?? '';
  return token ? { Authorization: `Bearer ${token}` } : {};
}
