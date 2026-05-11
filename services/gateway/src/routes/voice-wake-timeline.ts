/**
 * VTID-02917 (B0d.3): ORB Wake Reliability Timeline read API.
 *
 *   GET /api/v1/voice/wake-timeline?sessionId=…
 *       One full timeline (events + aggregates).
 *
 *   GET /api/v1/voice/wake-timeline/recent?userId=…&tenantId=…&limit=20
 *       Recent wakes (most-recent-first). Used by the Command Hub
 *       "ORB Wake Timeline" panel on the Journey Context screen.
 *
 * Auth: exafy_admin required. Both endpoints expose session-level
 * latency + disconnect telemetry that crosses tenant boundaries.
 *
 * B0d.3 hard rule: read-only. No tuning, no thresholds, no alerting
 * here. Surface only.
 */

import { Router, Response } from 'express';
import {
  requireAuthWithTenant,
  requireExafyAdmin,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { defaultWakeTimelineRecorder } from '../services/wake-timeline/wake-timeline-recorder';

const router = Router();
const VTID = 'VTID-02917';

router.get(
  '/voice/wake-timeline',
  requireAuthWithTenant,
  requireExafyAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
      if (!sessionId) {
        return res.status(400).json({
          ok: false,
          error: 'sessionId is required',
          vtid: VTID,
        });
      }
      const row = await defaultWakeTimelineRecorder.getTimeline(sessionId);
      if (!row) {
        return res.status(404).json({
          ok: false,
          error: 'wake_timeline_not_found',
          vtid: VTID,
        });
      }
      return res.json({ ok: true, vtid: VTID, timeline: row });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: (e as Error).message,
        vtid: VTID,
      });
    }
  },
);

router.get(
  '/voice/wake-timeline/recent',
  requireAuthWithTenant,
  requireExafyAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
      const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
      const limitRaw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 20;
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, limitRaw)) : 20;
      const rows = await defaultWakeTimelineRecorder.listRecent({
        userId,
        tenantId,
        limit,
      });
      return res.json({ ok: true, vtid: VTID, timelines: rows });
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
