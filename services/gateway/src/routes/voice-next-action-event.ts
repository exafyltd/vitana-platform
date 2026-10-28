/**
 * VTID-03062 (B0d-real slice Xf.2): next-action accepted/dismissed ingest.
 *
 *   POST /api/v1/voice/next-action/event
 *
 * Body:
 *   {
 *     decisionId: string,
 *     dedupeKey: string,
 *     eventName: 'accepted' | 'dismissed',
 *     source?: string,          // candidate source key, e.g. 'reminder_due'
 *     surface?: 'orb_wake' | 'orb_turn_end' | 'text_turn_end' | 'home',
 *     occurredAt?: string,      // ISO 8601
 *     metadata?: object         // free-form telemetry context
 *   }
 *
 * Auth: requireAuthWithTenant. Tenant + user IDs come from the JWT only.
 *
 * Lifecycle:
 *   - Xf.1 already emits `orb.livekit.next_action.suggested` server-side
 *     when a B0d-real candidate is selected.
 *   - THIS endpoint emits the matching `accepted` or `dismissed` event
 *     when the user follows or ignores the CTA.
 *   - Together, Xf.1 + Xf.2 give the Command Hub Candidate Inspector
 *     (Xf.3) the full lifecycle: suggested → (accepted | dismissed).
 *
 * Fire-and-forget downstream: the OASIS emit is awaited so the caller
 * knows whether it landed, but the body validation is strict enough
 * that bad clients fail fast. Mutation-free at the DB level — the
 * OASIS log itself is the audit trail.
 */

import { Router, Response } from 'express';
import {
  requireAuthWithTenant,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { emitOasisEvent } from '../services/oasis-event-service';
import {
  NEXT_ACTION_ACCEPTED,
  NEXT_ACTION_DISMISSED,
} from '../services/assistant-continuation/telemetry';

const router = Router();
const VTID = 'VTID-03062';

type LifecycleEventName = 'accepted' | 'dismissed';
const ALLOWED_EVENTS: ReadonlySet<LifecycleEventName> = new Set([
  'accepted',
  'dismissed',
]);

const ALLOWED_SURFACES: ReadonlySet<string> = new Set([
  'orb_wake',
  'orb_turn_end',
  'text_turn_end',
  'home',
]);

// Soft cap to keep payload size predictable + prevent abuse.
const MAX_METADATA_KEYS = 16;
const MAX_STRING_FIELD_CHARS = 512;

router.post(
  '/voice/next-action/event',
  requireAuthWithTenant,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const tenantId = req.identity?.tenant_id;
      const userId = req.identity?.user_id;
      if (!tenantId || !userId) {
        return res.status(401).json({
          ok: false,
          error: 'UNAUTHENTICATED',
          message: 'Authenticated session with active tenant required',
          vtid: VTID,
        });
      }

      const body = (req.body ?? {}) as Record<string, unknown>;

      const decisionId =
        typeof body.decisionId === 'string' ? body.decisionId.trim() : '';
      const dedupeKey =
        typeof body.dedupeKey === 'string' ? body.dedupeKey.trim() : '';
      const eventNameRaw = typeof body.eventName === 'string' ? body.eventName : '';
      const sourceRaw =
        typeof body.source === 'string' ? body.source.trim() : undefined;
      const surfaceRaw =
        typeof body.surface === 'string' ? body.surface : undefined;
      const occurredAt =
        typeof body.occurredAt === 'string' && body.occurredAt
          ? body.occurredAt
          : new Date().toISOString();
      const metadata =
        body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
          ? (body.metadata as Record<string, unknown>)
          : undefined;

      if (!decisionId) {
        return res
          .status(400)
          .json({ ok: false, error: 'decisionId is required', vtid: VTID });
      }
      if (decisionId.length > MAX_STRING_FIELD_CHARS) {
        return res
          .status(400)
          .json({ ok: false, error: 'decisionId too long', vtid: VTID });
      }
      if (!dedupeKey) {
        return res
          .status(400)
          .json({ ok: false, error: 'dedupeKey is required', vtid: VTID });
      }
      if (dedupeKey.length > MAX_STRING_FIELD_CHARS) {
        return res
          .status(400)
          .json({ ok: false, error: 'dedupeKey too long', vtid: VTID });
      }
      if (!ALLOWED_EVENTS.has(eventNameRaw as LifecycleEventName)) {
        return res.status(400).json({
          ok: false,
          error: `eventName must be one of: ${Array.from(ALLOWED_EVENTS).join(', ')}`,
          vtid: VTID,
        });
      }
      if (sourceRaw && sourceRaw.length > MAX_STRING_FIELD_CHARS) {
        return res
          .status(400)
          .json({ ok: false, error: 'source too long', vtid: VTID });
      }
      const surface =
        surfaceRaw && ALLOWED_SURFACES.has(surfaceRaw)
          ? (surfaceRaw as 'orb_wake' | 'orb_turn_end' | 'text_turn_end' | 'home')
          : undefined;
      if (metadata && Object.keys(metadata).length > MAX_METADATA_KEYS) {
        return res.status(400).json({
          ok: false,
          error: `metadata has more than ${MAX_METADATA_KEYS} keys`,
          vtid: VTID,
        });
      }

      const eventName = eventNameRaw as LifecycleEventName;
      const topic =
        eventName === 'accepted' ? NEXT_ACTION_ACCEPTED : NEXT_ACTION_DISMISSED;

      // Emit. Awaited so we can return 502 if the OASIS layer errors;
      // OASIS errors do NOT block voice paths in this endpoint because
      // we're not in the voice path (frontend-driven event).
      try {
        await emitOasisEvent({
          vtid: VTID,
          type: topic as never,
          source: 'b0d-real-next-action',
          status: 'info',
          message: topic,
          payload: {
            user_id: userId,
            tenant_id: tenantId,
            decision_id: decisionId,
            dedupe_key: dedupeKey,
            event_name: eventName,
            source: sourceRaw ?? null,
            surface: surface ?? null,
            occurred_at: occurredAt,
            metadata: metadata ?? null,
          },
          actor_id: userId,
          actor_role: 'user',
          surface: 'orb',
        });
      } catch (emitErr) {
        console.warn(
          `[${VTID}] emit failed: ${(emitErr as Error).message}`,
        );
        return res
          .status(502)
          .json({ ok: false, error: 'telemetry_emit_failed', vtid: VTID });
      }

      return res.status(200).json({
        ok: true,
        vtid: VTID,
        decision_id: decisionId,
        dedupe_key: dedupeKey,
        event_name: eventName,
        topic,
      });
    } catch (err) {
      console.error(`[${VTID}] route error: ${(err as Error).message}`);
      return res
        .status(500)
        .json({ ok: false, error: 'internal_error', vtid: VTID });
    }
  },
);

export default router;
