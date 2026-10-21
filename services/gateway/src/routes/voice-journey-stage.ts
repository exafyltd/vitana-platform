/**
 * VTID-02937 (B4) — Tenure & Journey Stage preview API.
 *
 *   GET /api/v1/voice/journey-stage/preview?userId=…&tenantId=…
 *
 * Returns the compiled JourneyStageContext + the raw rows the
 * assistant decision layer would see (tenure, active days, latest
 * Index score). Read-only.
 *
 * Auth: requireExafyAdmin (same as B0c/B0d/B0e/R0/B1/B2/B3
 * inspection surfaces).
 *
 * Wall: zero mutation paths. The signals are read from
 * authoritative sources already populated by other code paths
 * (app_users via the user-provisioning trigger, user_active_days
 * via JWT auth middleware, vitana_index_scores via the Index
 * compute pipeline).
 */

import { Router, Response } from 'express';
import {
  requireAuthWithTenant,
  requireExafyAdmin,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { defaultJourneyStageFetcher } from '../services/journey-stage/journey-stage-fetcher';
import { compileJourneyStageContext } from '../services/journey-stage/compile-journey-stage-context';

const router = Router();
const VTID = 'VTID-02937';

router.get(
  '/voice/journey-stage/preview',
  requireAuthWithTenant,
  requireExafyAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = typeof req.query.userId === 'string' ? req.query.userId : '';
      const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : '';
      if (!userId || !tenantId) {
        return res.status(400).json({
          ok: false,
          error: 'userId and tenantId are required',
          vtid: VTID,
        });
      }

      const [appUserResult, activeDaysResult, indexHistoryResult] = await Promise.all([
        defaultJourneyStageFetcher.fetchAppUser({ userId }),
        defaultJourneyStageFetcher.fetchUserActiveDaysAggregate({ userId }),
        defaultJourneyStageFetcher.fetchVitanaIndexHistory({ tenantId, userId, limit: 60 }),
      ]);

      const context = compileJourneyStageContext({
        appUserResult,
        activeDaysResult,
        indexHistoryResult,
      });

      return res.json({
        ok: true,
        vtid: VTID,
        app_user: appUserResult.row,
        active_days: activeDaysResult.aggregate,
        index_history_head: indexHistoryResult.rows.slice(0, 10),
        context,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: (e as Error).message,
        vtid: VTID,
      });
    }
  },
);

export default router;
