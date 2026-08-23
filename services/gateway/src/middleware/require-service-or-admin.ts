/**
 * Canonical auth gates for internal/operator control-plane routes.
 *
 * Two Express middlewares, both modelled on the existing `emitAuthGate` in
 * routes/oasis-emit.ts so the behaviour is identical across the surface:
 *
 *   requireServiceOrAdmin — accepts EITHER
 *     • `Authorization: Bearer <GATEWAY_SERVICE_TOKEN>` (CI / internal callers), OR
 *     • `Authorization: Bearer <JWT>` where the validated JWT is `exafy_admin`.
 *     Use for machine-driven ingestion endpoints (e.g. self-healing `/report`)
 *     that a human operator may also invoke.
 *
 *   requireAdminOnly — accepts ONLY an `exafy_admin` JWT. Use for state-changing
 *     operator actions (kill switch, config, approve/reject, verify, rollback).
 *
 * Both fail CLOSED: a missing/empty/malformed token, or a JWT without
 * `exafy_admin`, yields 401/403. The service-token comparison is checked first
 * so an unauthenticated request never triggers JWT validation overhead and a
 * malformed JWT can't accidentally match the constant-string compare.
 *
 * Introduced by the self-healing control-plane hardening (audit P0-1). Kept
 * generic + reusable so other internal routers can consolidate onto it.
 */

import { Request, Response, NextFunction } from 'express';
import {
  optionalAuth,
  AuthenticatedRequest,
} from './auth-supabase-jwt';

/** Actor label attached to the request for downstream audit logging. */
export type ControlPlaneActor = string;

interface ActorRequest extends Request {
  __control_plane_actor?: ControlPlaneActor;
}

function extractBearer(req: Request): string | null {
  const header = req.header('authorization') ?? req.header('Authorization');
  if (!header || !header.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice('bearer '.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Constant-time-ish comparison guard: only treat the caller as the service
 * identity when GATEWAY_SERVICE_TOKEN is configured AND matches exactly. An
 * unset/empty env var must never authorise (would otherwise match an empty
 * token — which extractBearer already rejects, but be explicit).
 */
function matchesServiceToken(token: string): boolean {
  const serviceToken = process.env.GATEWAY_SERVICE_TOKEN ?? '';
  return serviceToken.length > 0 && token === serviceToken;
}

/**
 * Require a valid GATEWAY_SERVICE_TOKEN OR an exafy_admin JWT.
 */
export function requireServiceOrAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const token = extractBearer(req);
  if (!token) {
    res.status(401).json({ ok: false, error: 'missing bearer token' });
    return;
  }

  // Path 1: service-token match (cheap constant compare, no JWT overhead).
  if (matchesServiceToken(token)) {
    (req as ActorRequest).__control_plane_actor = 'service:internal';
    next();
    return;
  }

  // Path 2: JWT — must resolve to an exafy_admin identity.
  optionalAuth(req as AuthenticatedRequest, res, () => {
    const id = (req as AuthenticatedRequest).identity;
    if (id && id.exafy_admin === true) {
      (req as ActorRequest).__control_plane_actor = `admin:${id.user_id ?? 'unknown'}`;
      next();
      return;
    }
    res.status(id ? 403 : 401).json({
      ok: false,
      error: id
        ? 'forbidden — exafy_admin privileges required'
        : 'unauthorized — service token or exafy_admin JWT required',
    });
  });
}

/**
 * Require an exafy_admin JWT. The service token is NOT accepted — these are
 * deliberate operator actions that must be attributable to a human admin.
 */
export function requireAdminOnly(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const token = extractBearer(req);
  if (!token) {
    res.status(401).json({ ok: false, error: 'missing bearer token' });
    return;
  }

  optionalAuth(req as AuthenticatedRequest, res, () => {
    const id = (req as AuthenticatedRequest).identity;
    if (id && id.exafy_admin === true) {
      (req as ActorRequest).__control_plane_actor = `admin:${id.user_id ?? 'unknown'}`;
      next();
      return;
    }
    res.status(id ? 403 : 401).json({
      ok: false,
      error: id
        ? 'forbidden — exafy_admin privileges required'
        : 'unauthorized — exafy_admin JWT required',
    });
  });
}

/** Read the control-plane actor label set by the gates above (for audit logs). */
export function getControlPlaneActor(req: Request): ControlPlaneActor {
  return (req as ActorRequest).__control_plane_actor ?? 'unknown';
}
