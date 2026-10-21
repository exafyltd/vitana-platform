/**
 * VTID-04878 — POST /api/v1/rewards/sweep: run the VTNA reward sweep now.
 *
 * Internal or exafy_admin only (requireInternalOrAdmin). Used once after the
 * production deploy for the backfill (quiet: no celebration events for
 * milestones reached before the ledger existed). Refuses on staging with
 * 409 NOT_PRODUCTION before any read or write — staging shares the
 * production database.
 */
import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase';
import { requireInternalOrAdmin } from './automations';
import { runAndReportRewardSweep } from '../services/rewards/reward-sweep-runner';
import { rewardSweepAllowed } from '../services/rewards/reward-sweep';

const router = Router();

router.post('/rewards/sweep', requireInternalOrAdmin, async (req: Request, res: Response) => {
  // impact-allow-no-oasis: runAndReportRewardSweep() emits rewards.milestone_sweep.completed / .failed for every run.
  const allowed = rewardSweepAllowed();
  if (!allowed.ok) return res.status(409).json({ ok: false, error: allowed.error });

  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED' });

  const quiet = req.body?.quiet !== false; // backfill by default
  const summary = await runAndReportRewardSweep(sb, { quiet, trigger: 'manual' });
  return res.status(summary.ok ? 200 : 500).json(summary);
});

export default router;
