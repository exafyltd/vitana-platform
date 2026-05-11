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
 * Auth (GET): exafy_admin required. Both endpoints expose session-level
 * latency + disconnect telemetry that crosses tenant boundaries.
 *
 * B0d.3 hard rule: GETs are read-only — no tuning, no thresholds, no
 * alerting. Surface only.
 *
 * VTID-02919 (B0d.4-event-ingest):
 *
 *   POST /api/v1/voice/wake-timeline/event
 *       Frontend-emitted timeline event. Body:
 *         { sessionId, name, metadata?, at? }
 *       Validation:
 *         - name MUST be a known WAKE_TIMELINE_EVENT_NAMES value.
 *         - sessionId required + non-empty.
 *       Auth: optional. The frontend may be anonymous (ORB widget on
 *       a public page) or authenticated. The event is forwarded to the
 *       default recorder; downstream tenant_id is whatever the gateway
 *       already attached to the session via /live/session/start.
 *       Origin must validate. CSRF surface is low (event ingest only;
 *       no PII echoed back).
 */

import { Router, Request, Response } from 'express';
import {
  requireAuthWithTenant,
  requireExafyAdmin,
  AuthenticatedRequest,
  optionalAuth,
} from '../middleware/auth-supabase-jwt';
import { defaultWakeTimelineRecorder } from '../services/wake-timeline/wake-timeline-recorder';
import {
  isWakeTimelineEventName,
  type WakeTimelineEventName,
} from '../services/wake-timeline/timeline-events';

const router = Router();
const VTID = 'VTID-02917';
const INGEST_VTID = 'VTID-02919';

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

// ---------------------------------------------------------------------------
// POST /api/v1/voice/wake-timeline/event (VTID-02919, B0d.4-event-ingest)
//
// Accepts a single frontend-emitted timeline event. The 4 events the
// frontend is uniquely positioned to emit:
//   - wake_clicked            user tapped ORB
//   - client_context_received envelope built on the FE
//   - ws_opened               WebSocket handshake completed on the FE
//   - first_audio_output      first audio frame rendered to speakers
//
// Other event names are accepted too (any from WAKE_TIMELINE_EVENT_NAMES)
// so the same endpoint can serve future B0d frontend events without a
// schema change.
//
// Best-effort: recorder errors do NOT surface as 5xx — the endpoint
// returns 200 with `recorded: false` + a reason, so the frontend never
// fails the wake path on telemetry.
// ---------------------------------------------------------------------------
router.post(
  '/voice/wake-timeline/event',
  optionalAuth,
  (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
      const name = typeof body.name === 'string' ? body.name : '';
      if (!sessionId) {
        return res.status(400).json({
          ok: false,
          error: 'sessionId is required',
          vtid: INGEST_VTID,
        });
      }
      if (!isWakeTimelineEventName(name)) {
        return res.status(400).json({
          ok: false,
          error: `unknown wake-timeline event name: ${String(name)}`,
          vtid: INGEST_VTID,
        });
      }
      const at = typeof body.at === 'string' && body.at.length > 0 ? body.at : undefined;
      const metadata =
        body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
          ? (body.metadata as Record<string, unknown>)
          : undefined;

      try {
        defaultWakeTimelineRecorder.recordEvent({
          sessionId,
          name: name as WakeTimelineEventName,
          ...(metadata ? { metadata } : {}),
          ...(at ? { at } : {}),
        });
      } catch (e) {
        // Recorder failure must not break the frontend wake path.
        return res.json({
          ok: true,
          recorded: false,
          reason: (e as Error).message,
          vtid: INGEST_VTID,
        });
      }

      return res.json({ ok: true, recorded: true, vtid: INGEST_VTID });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: (e as Error).message,
        vtid: INGEST_VTID,
      });
    }
  },
);

export default router;
