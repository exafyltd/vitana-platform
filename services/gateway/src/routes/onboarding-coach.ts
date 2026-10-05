/**
 * VTID-04892 — Vitana Onboarding Assistant, read-only status.
 *
 *   GET /api/v1/onboarding-coach/status → { ok, mode, reason, env }
 *
 * Reports only which mode the coach is in here (disabled-on-staging | off |
 * shadow) — no member data, no counts. Public and read-only on purpose: the
 * staging verification suite (read-only by rule 48) checks it with a plain GET.
 */
import { Router, Request, Response } from 'express';
import { resolveCoachConfig } from '../services/onboarding-coach/config';
import { VITANA_ENV } from '../env';

const router = Router();

router.get('/status', (_req: Request, res: Response) => {
  const config = resolveCoachConfig();
  res.json({ ok: true, mode: config.mode, reason: config.reason, env: VITANA_ENV });
});

export default router;
