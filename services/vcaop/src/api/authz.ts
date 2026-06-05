/**
 * Authz middleware for the VCAOP API (CTRL-API-0004, runbook Sec. 5).
 *
 * Two layers protect every endpoint: (1) this Gateway role/ownership middleware and
 * (2) Supabase RLS (IAM-ROLES-0001). This module is layer (1).
 *
 * Auth resolution here is pluggable: the real Gateway supplies an `authResolver`
 * built from its JWT/session middleware. For tests/dev a header-based resolver is
 * provided. No secret material is read or logged.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthContext, Role, isRole } from './types';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      vcaop?: AuthContext;
    }
  }
}

export type AuthResolver = (req: Request) => AuthContext | null;

/** Header-based resolver for tests/dev. The real Gateway replaces this with its JWT auth. */
export const headerAuthResolver: AuthResolver = (req) => {
  const userId = req.header('x-user-id');
  const tenantId = req.header('x-tenant-id') ?? 'platform';
  const role = req.header('x-role');
  if (!userId || !isRole(role)) return null;
  return { userId, tenantId, role };
};

/** Attach req.vcaop or 401. */
export function withAuth(resolver: AuthResolver): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const ctx = resolver(req);
    if (!ctx) {
      res.status(401).json({ ok: false, error: 'unauthorized', code: 'UNAUTHENTICATED' });
      return;
    }
    req.vcaop = ctx;
    next();
  };
}

/** Require one of the given roles, else 403. */
export function requireRole(...allowed: Role[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const ctx = req.vcaop;
    if (!ctx) {
      res.status(401).json({ ok: false, error: 'unauthorized', code: 'UNAUTHENTICATED' });
      return;
    }
    if (!allowed.includes(ctx.role)) {
      res.status(403).json({ ok: false, error: `forbidden: requires ${allowed.join('|')}`, code: 'FORBIDDEN' });
      return;
    }
    next();
  };
}
