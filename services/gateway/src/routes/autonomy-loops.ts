/**
 * VTID-05084 — Loop Engineering catalog API (read-only).
 *
 *   GET /api/v1/autonomy/loops
 *
 * Returns the 14 loops, the shared engine components, the overlaps the
 * Simplify loop works through, sensor coverage, and a plane-level 7-day run
 * signal from agent_runs_unified. Backs Command Hub → Autonomy → Loops.
 * VTID-05148: `metrics_latest.L3` carries the latest learn-outcomes run's
 * metrics (routine_runs findings) for the L3 card. VTID-05153: `metrics_latest.L9`
 * the latest supplier-catalog-check run's metrics for the L9 card.
 *
 * GET only: nothing here writes. exafy_admin only, through the shared
 * middleware (no local copy of the dev-role check).
 */

import { Router, Response } from 'express';
import { requireAuth, requireExafyAdmin, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { buildCatalogResponse } from '../services/loop-catalog';

const router = Router();
const LOG_PREFIX = '[autonomy-loops]';

router.get('/loops', requireAuth, requireExafyAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const data = await buildCatalogResponse(getSupabase());
    return res.status(200).json({ ok: true, data });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} catalog unavailable:`, err?.message);
    return res.status(500).json({ ok: false, error: 'LOOP_CATALOG_UNAVAILABLE' });
  }
});

export default router;
