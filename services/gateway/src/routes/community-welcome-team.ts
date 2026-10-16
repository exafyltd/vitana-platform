/**
 * VTID-05205 — team welcome DMs (Mariia, Jovana, Alex Blue).
 *
 *   GET /api/v1/welcome-team/status → { ok, mode, reason, audience, rollout_at, stagger_days, ready_locales, env }
 *
 * Public and read-only on purpose: it reports only which mode the tick is in
 * and its switches — no member data, no counts, no account ids — so the
 * read-only staging verification suite (CLAUDE.md rule 48) can check it with
 * a plain GET. The tick itself is POST /api/v1/scheduled-notifications/welcome-team-tick.
 */
import { Router, Request, Response } from 'express';
import { resolveWelcomeTeamConfig, publicStatus } from '../services/welcome-team/config';
import { VITANA_ENV } from '../env';

const router = Router();

// Public on purpose: mode and switches only, no member data — the read-only staging suite (rule 48) checks it without a sign-in.
router.get('/status', (_req: Request, res: Response) => { // public-route
  const config = resolveWelcomeTeamConfig();
  res.json({ ok: true, ...publicStatus(config), env: VITANA_ENV });
});

export default router;
