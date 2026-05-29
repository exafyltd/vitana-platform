/**
 * VTID-02924 (B0e.4): capability awareness event ingestion.
 *
 *   POST /api/v1/voice/feature-discovery/event
 *
 * Body:
 *   {
 *     capabilityKey: string,
 *     eventName: 'introduced'|'seen'|'tried'|'completed'|'dismissed'|'mastered',
 *     idempotencyKey: string,
 *     decisionId?: string,
 *     sourceSurface?: 'orb_wake'|'orb_turn_end'|'text_turn_end'|'home',
 *     occurredAt?: string,        // ISO 8601
 *     metadata?: object
 *   }
 *
 * Auth: requireAuthWithTenant. Tenant + user IDs come from the JWT,
 * NOT from the body — that's the tenant/user mismatch guard the user
 * called out in acceptance check #4.
 *
 * Wall discipline: this is the ONLY endpoint that mutates awareness
 * state. The preview/inspection routes (B0e.3) and the provider
 * (B0e.2) NEVER touch this surface.
 */

import { Router, Response } from 'express';
import {
  requireAuthWithTenant,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import {
  defaultCapabilityAwarenessService,
  type IngestResult,
} from '../services/capability-awareness/capability-awareness-service';
import type { CapabilityAwarenessEventName } from '../services/assistant-continuation/telemetry';

const router = Router();
const VTID = 'VTID-02924';

const ALLOWED_EVENTS: ReadonlySet<CapabilityAwarenessEventName> = new Set([
  'introduced', 'seen', 'tried', 'completed', 'dismissed', 'mastered',
]);

const ALLOWED_SURFACES: ReadonlySet<string> = new Set([
  'orb_wake', 'orb_turn_end', 'text_turn_end', 'home',
]);

router.post(
  '/voice/feature-discovery/event',
  requireAuthWithTenant,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      // ---- Identity from JWT only — NEVER from body ----
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

      // ---- Body validation ----
      const capabilityKey = typeof body.capabilityKey === 'string' ? body.capabilityKey.trim() : '';
      const eventNameRaw = typeof body.eventName === 'string' ? body.eventName : '';
      const idempotencyKey =
        typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
      const decisionId = typeof body.decisionId === 'string' ? body.decisionId : undefined;
      const sourceSurfaceRaw =
        typeof body.sourceSurface === 'string' ? body.sourceSurface : undefined;
      const occurredAt = typeof body.occurredAt === 'string' ? body.occurredAt : undefined;
      const metadata =
        body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
          ? (body.metadata as Record<string, unknown>)
          : undefined;

      if (!capabilityKey) {
        return res.status(400).json({ ok: false, error: 'capabilityKey is required', vtid: VTID });
      }
      if (!ALLOWED_EVENTS.has(eventNameRaw as CapabilityAwarenessEventName)) {
        return res.status(400).json({
          ok: false,
          error: `eventName must be one of ${Array.from(ALLOWED_EVENTS).join(', ')}`,
          vtid: VTID,
        });
      }
      if (!idempotencyKey) {
        return res.status(400).json({
          ok: false,
          error: 'idempotencyKey is required',
          vtid: VTID,
        });
      }
      const sourceSurface =
        sourceSurfaceRaw && ALLOWED_SURFACES.has(sourceSurfaceRaw)
          ? (sourceSurfaceRaw as
              | 'orb_wake'
              | 'orb_turn_end'
              | 'text_turn_end'
              | 'home')
          : undefined;

      // ---- Invoke the service (the ONLY mutation entrypoint) ----
      const result: IngestResult = await defaultCapabilityAwarenessService.ingest({
        tenantId,
        userId,
        capabilityKey,
        eventName: eventNameRaw as CapabilityAwarenessEventName,
        idempotencyKey,
        decisionId,
        sourceSurface,
        occurredAt,
        metadata,
      });

      if (!result.ok) {
        // Map service reasons to HTTP status codes.
        const status =
          result.reason === 'unknown_capability'
            ? 404
            : result.reason === 'transition_not_allowed'
              ? 409
              : result.reason === 'database_unavailable'
                ? 503
                : 400;
        return res.status(status).json({
          ok: false,
          reason: result.reason,
          detail: result.detail ?? null,
          previousState: result.previousState ?? null,
          vtid: VTID,
        });
      }

      return res.json({
        ok: true,
        vtid: VTID,
        idempotent: result.idempotent,
        previousState: result.previousState,
        nextState: result.nextState,
        eventId: result.eventId,
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
