/**
 * VTID-05099 — Vitana Companion Messages, read-only status.
 *
 *   GET /api/v1/companion/status → { ok, mode, reason, env }
 *
 * Reports only which mode the engine is in here (disabled-on-staging | off |
 * shadow) — no member data, no counts. Public and read-only on purpose: the
 * staging verification suite (read-only by rule 48) checks it with a plain GET.
 * Member preferences (GET/PATCH /preferences) arrive with Phase 2 (VTID-05100).
 */
import { Router, Request, Response } from 'express';
import { resolveCompanionConfig } from '../services/companion/config';
import { VITANA_ENV } from '../env';

const router = Router();

// Public on purpose: mode only, no member data — the read-only staging suite (rule 48) checks it without a sign-in.
router.get('/status', (_req: Request, res: Response) => { // public-route
  const config = resolveCompanionConfig();
  res.json({ ok: true, mode: config.mode, reason: config.reason, env: VITANA_ENV });
});

export default router;
