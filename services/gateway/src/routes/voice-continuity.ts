/**
 * VTID-02932 (B2) — Conversation Continuity preview API.
 *
 *   GET /api/v1/voice/continuity/preview?userId=…&tenantId=…
 *
 * Returns the compiled ContinuityContext + the raw threads/promises
 * rows the assistant decision layer would see. Read-only.
 *
 * Auth: requireExafyAdmin (same as B0c/B0d/B0e/R0/B1 inspection
 * surfaces).
 *
 * Wall: zero mutation paths. Selection is read-only; state
 * advancement is a follow-up slice with its own dedicated event
 * endpoint.
 */

import { Router, Response } from 'express';
import {
  requireAuthWithTenant,
  requireExafyAdmin,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { defaultContinuityFetcher } from '../services/continuity/continuity-fetcher';
import { compileContinuityContext } from '../services/continuity/compile-continuity-context';

const router = Router();
const VTID = 'VTID-02932';

router.get(
  '/voice/continuity/preview',
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

      const [threadsResult, promisesResult] = await Promise.all([
        defaultContinuityFetcher.listOpenThreads({ tenantId, userId, limit: 50 }),
        defaultContinuityFetcher.listPromises({ tenantId, userId, limit: 50 }),
      ]);

      const context = compileContinuityContext({ threadsResult, promisesResult });

      return res.json({
        ok: true,
        vtid: VTID,
        threads: threadsResult.rows,
        promises: promisesResult.rows,
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
