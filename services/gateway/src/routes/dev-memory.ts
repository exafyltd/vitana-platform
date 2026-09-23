/**
 * VTID-04407 / VTID-04408 — developer memory routes, mounted at /api/v1/dev-memory.
 *
 *   GET  /morning-pack     the owner's handoffs + the week's knowledge + VTIDs in progress
 *   POST /handoffs/sweep   write handoffs for Operator threads that went quiet (hourly cron)
 *
 * Auth. /morning-pack accepts three callers:
 *   - an exafy_admin session (the pack is filtered to the caller's own handoffs);
 *   - `X-Dev-Memory-Token` matching DEV_MEMORY_PACK_TOKEN — a read-only token
 *     for the Claude Code SessionStart hook, which has no user session.
 *     Off unless the env var is set (≥ 24 chars); constant-time compare;
 *     `?author_user_id=` narrows the handoffs;
 *   - `X-Gateway-Internal` (same as the other internal routes).
 * /handoffs/sweep accepts X-Gateway-Internal or an exafy_admin session only.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { requireAdminAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { emitOasisEvent } from '../services/oasis-event-service';
import { buildMorningPack } from '../services/dev-memory/morning-pack';
import { runHandoffSweep } from '../services/dev-memory/handoff';
import type { DevMemoryRepo } from '../services/dev-agent-memory';

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PACK_TOKEN_MIN_CHARS = 24;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function hasInternalToken(req: Request, env: NodeJS.ProcessEnv = process.env): boolean {
  const expected = env.GATEWAY_INTERNAL_TOKEN;
  const got = req.get('X-Gateway-Internal');
  return Boolean(expected && got && safeEqual(got, expected));
}

export function hasPackToken(req: Request, env: NodeJS.ProcessEnv = process.env): boolean {
  const expected = env.DEV_MEMORY_PACK_TOKEN;
  const got = req.get('X-Dev-Memory-Token');
  if (!expected || expected.length < PACK_TOKEN_MIN_CHARS || !got) return false;
  return safeEqual(got, expected);
}

type Caller = { kind: 'admin'; userId: string | null } | { kind: 'service' };

function authorize(opts: { allowPackToken: boolean }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (hasInternalToken(req) || (opts.allowPackToken && hasPackToken(req))) {
      (req as any).devMemoryCaller = { kind: 'service' } as Caller;
      return next();
    }
    return requireAdminAuth(req as AuthenticatedRequest, res, () => {
      (req as any).devMemoryCaller = { kind: 'admin', userId: (req as AuthenticatedRequest).identity?.user_id ?? null } as Caller;
      next();
    });
  };
}

function parseRepo(v: unknown): DevMemoryRepo {
  return v === 'vitana-v1' ? 'vitana-v1' : 'vitana-platform';
}

router.get('/morning-pack', authorize({ allowPackToken: true }), async (req: Request, res: Response) => {
  const caller = (req as any).devMemoryCaller as Caller;
  let author: string | null = null;
  if (caller.kind === 'admin') author = caller.userId && UUID_RE.test(caller.userId) ? caller.userId : null;
  else if (typeof req.query.author_user_id === 'string') {
    if (!UUID_RE.test(req.query.author_user_id)) return res.status(400).json({ ok: false, error: 'INVALID_AUTHOR_USER_ID' });
    author = req.query.author_user_id.toLowerCase();
  }
  const r = await buildMorningPack({ repo: parseRepo(req.query.repo), authorUserId: author });
  if (!r.ok) return res.status(503).json({ ok: false, error: r.error });
  if (req.query.format === 'text') return res.type('text/plain').send(r.pack.text);
  return res.json({ ok: true, pack: r.pack });
});

router.post('/handoffs/sweep', authorize({ allowPackToken: false }), async (_req: Request, res: Response) => {
  const result = await runHandoffSweep();
  if (result.written > 0) {
    emitOasisEvent({
      vtid: 'VTID-04407',
      type: 'dev_memory.handoffs.written' as any,
      source: 'dev-memory',
      status: 'info',
      message: `Wrote ${result.written} Operator thread handoff(s)`,
      payload: { ...result },
    }).catch(() => undefined);
  }
  return res.json({ ok: true, ...result });
});

export default router;
