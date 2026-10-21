/**
 * VTID-02859: Awareness Watchdogs API.
 *
 *   GET /api/v1/voice/awareness/watchdogs   per-watchdog status (live telemetry)
 *
 * Surfaced under the Voice / Awareness / Watchdogs sub-tab so operators can
 * scan in one place "is each awareness signal still firing?" without
 * having to grep oasis_events by hand.
 */

import { Router, Request, Response } from 'express';
import { getWatchdogStatuses } from '../services/awareness-watchdogs';
import { requireAuth, requireExafyAdmin } from '../middleware/auth-supabase-jwt';

const router = Router();
const VTID = 'VTID-02859';

// VTID-04339: operator telemetry — admin only. Guards are per-handler because
// this router is mounted at /api/v1 (a path-less router.use would gate every
// /api/v1 request, the VTID-02032 bug).
router.get('/voice/awareness/watchdogs', requireAuth, requireExafyAdmin, async (_req: Request, res: Response) => {
  try {
    const statuses = await getWatchdogStatuses();
    res.json({ ok: true, watchdogs: statuses, vtid: VTID });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message, vtid: VTID });
  }
});

export default router;
