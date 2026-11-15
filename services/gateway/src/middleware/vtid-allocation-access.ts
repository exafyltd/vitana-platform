/**
 * VTID-05800 — anyone may allocate a VTID (owner decision 2026-11-15).
 *
 * Owner: "allocating a vtid should be the easiest thing in the world, manually possible, single click possible, any
 * way that you can imagine should make it possible for any machine any human with any process to allocate a fresh
 * vtid." So the allocation routes (POST /api/v1/vtid/allocate and POST /api/v1/vtid/allocate-internal) need no
 * sparring record, no CI run, no admin role and no token, in every LEDGER_WRITE_AUTH_MODE. That switch still guards
 * the routes that create a task with caller-chosen fields, edit, close or delete one (VTID-04727).
 *
 * The caller is identified when it can be, only to record who allocated:
 *   service:internal       Authorization: Bearer <GATEWAY_SERVICE_TOKEN>
 *   service:alloc-secret   X-VTID-Alloc-Secret: <VTID_ALLOC_SECRET>
 *   admin:<user_id>        a valid exafy_admin JWT
 *   user:<user_id>         any other valid JWT
 *   anonymous              anything else, including a wrong or expired token (never a 401)
 *
 * Two limits that do not stop normal use:
 *   - an anonymous caller may allocate VTID_ALLOC_ANON_PER_MINUTE (default 30) a minute and VTID_ALLOC_ANON_PER_HOUR
 *     (default 300) an hour per client, so a script cannot use up the five-digit VTID space; 0 turns a limit off.
 *     Identified callers are never limited.
 *   - only the service token or an exafy_admin may label a VTID `source: self-healing`, because that label makes a
 *     task eligible for autonomous execution (CLAUDE.md §4 criterion 5, NEVER 34). Every other source is free.
 */
import { timingSafeEqual } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { optionalAuth, AuthenticatedRequest } from './auth-supabase-jwt';

export const ANONYMOUS = 'anonymous';
export const DEFAULT_ANON_PER_MINUTE = 30;
export const DEFAULT_ANON_PER_HOUR = 300;
const RESERVED_SOURCES = new Set(['self-healing']);

interface VtidAllocRequest extends Request {
  __vtid_alloc_actor?: string;
  __ledger_write_actor?: string;
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function bearer(req: Request): string | null {
  const header = req.header('authorization') ?? req.header('Authorization');
  if (!header || !header.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice('bearer '.length).trim();
  return token.length > 0 ? token : null;
}

/** Who is allocating. Never rejects: an unknown or invalid credential is `anonymous`. */
export async function identifyVtidCaller(req: Request): Promise<string> {
  const token = bearer(req);
  const serviceToken = process.env.GATEWAY_SERVICE_TOKEN ?? '';
  if (token && serviceToken.length > 0 && sameSecret(token, serviceToken)) return 'service:internal';

  const allocSecret = process.env.VTID_ALLOC_SECRET ?? '';
  const header = req.headers['x-vtid-alloc-secret'];
  const provided = Array.isArray(header) ? header[0] : header;
  if (allocSecret.length > 0 && typeof provided === 'string' && sameSecret(provided, allocSecret)) return 'service:alloc-secret';

  if (!token) return ANONYMOUS;
  try {
    await new Promise<void>((resolve, reject) => {
      // optionalAuth never responds; it only attaches req.identity when the JWT verifies.
      Promise.resolve(optionalAuth(req as AuthenticatedRequest, {} as Response, () => resolve())).catch(reject);
    });
  } catch {
    return ANONYMOUS;
  }
  const id = (req as AuthenticatedRequest).identity;
  if (!id || !id.user_id) return ANONYMOUS;
  return id.exafy_admin === true ? `admin:${id.user_id}` : `user:${id.user_id}`;
}

/** The caller recorded by allowVtidAllocation, or `anonymous`. */
export function getVtidAllocActor(req: Request): string {
  return (req as VtidAllocRequest).__vtid_alloc_actor ?? ANONYMOUS;
}

export function isReservedSource(source: unknown): boolean {
  return typeof source === 'string' && RESERVED_SOURCES.has(source.trim().toLowerCase());
}

/** The service token, the alloc secret and an exafy_admin may use a reserved source; nobody else. */
export function mayUseReservedSource(actor: string): boolean {
  return actor.startsWith('service:') || actor.startsWith('admin:');
}

function limitFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export const anonPerMinute = (): number => limitFromEnv('VTID_ALLOC_ANON_PER_MINUTE', DEFAULT_ANON_PER_MINUTE);
export const anonPerHour = (): number => limitFromEnv('VTID_ALLOC_ANON_PER_HOUR', DEFAULT_ANON_PER_HOUR);

/**
 * The client an anonymous allocation is counted against. Behind the ALB every request has the same socket address and
 * the gateway sets no `trust proxy`, so req.ip would be one bucket for every anonymous caller. The ALB appends the
 * address it saw to X-Forwarded-For, so the LAST hop is the real client and cannot be forged; earlier hops are what
 * the client sent and are ignored. Without the header (a direct call), req.ip is used.
 */
export function anonClientKey(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  const hops = (Array.isArray(xff) ? xff.join(',') : xff || '').split(',').map((h) => h.trim()).filter(Boolean);
  const ip = hops.length > 0 ? hops[hops.length - 1] : req.ip || 'unknown';
  return `ip:${ipKeyGenerator(ip)}`;
}

const tooMany = {
  ok: false,
  error: 'rate_limited',
  message:
    'Too many anonymous VTID allocations from this client. Wait a little, or sign in or send the service token: identified callers are not limited.',
};

function anonLimiter(windowMs: number, limit: () => number) {
  return rateLimit({
    windowMs,
    limit: () => Math.max(1, limit()),
    skip: (req: Request) => getVtidAllocActor(req) !== ANONYMOUS || limit() === 0,
    keyGenerator: anonClientKey,
    // anonClientKey reads X-Forwarded-For itself, so the library's trust-proxy warning does not apply.
    validate: { xForwardedForHeader: false },
    standardHeaders: true,
    legacyHeaders: false,
    message: tooMany,
  });
}

const perMinuteLimiter = anonLimiter(60 * 1000, anonPerMinute);
const perHourLimiter = anonLimiter(60 * 60 * 1000, anonPerHour);

/** Open gate for the allocation routes: identifies the caller, limits only anonymous callers, never asks for auth. */
export function allowVtidAllocation(req: Request, res: Response, next: NextFunction): void {
  identifyVtidCaller(req)
    .catch(() => ANONYMOUS)
    .then((actor) => {
      (req as VtidAllocRequest).__vtid_alloc_actor = actor;
      if (actor !== ANONYMOUS) (req as VtidAllocRequest).__ledger_write_actor = actor;
      perMinuteLimiter(req, res, (err?: unknown) => {
        if (err) return next(err);
        perHourLimiter(req, res, next);
      });
    });
}
