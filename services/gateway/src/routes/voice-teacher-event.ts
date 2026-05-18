/**
 * VTID-03094 (Teacher PR 4) — Teacher lifecycle endpoint.
 *
 *   POST /api/v1/voice/teacher/event
 *
 * Body:
 *   {
 *     capabilityKey: string,                            // required, ∈ system_capabilities
 *     eventName: 'introduced'|'seen'|'tried'|'completed'|'dismissed',
 *     idempotencyKey: string,                           // required (client-generated UUID)
 *     decisionId?: string,                              // from wake_brief_decision
 *     sourceSurface?: 'orb_wake'|'orb_turn_end'|'text_turn_end'|'home',
 *     occurredAt?: string,                              // ISO 8601
 *     metadata?: Record<string, unknown>                // <=16 keys
 *   }
 *
 * Auth: requireAuthWithTenant. Tenant + user IDs come from the JWT only.
 *
 * Flow:
 *   1. Validate body.
 *   2. Call `advance_capability_awareness` RPC (atomic, idempotent,
 *      state-machine enforced — see VTID-02924 migration).
 *   3. Emit OASIS event using the AWARENESS_EVENT_TO_TOPIC map (NEVER
 *      construct topic strings inline).
 *   4. When eventName is 'introduced' AND the chosen capability has a
 *      manual_path, return a `navigate` directive so the frontend can
 *      open the page.
 *
 * The RPC's idempotency key means re-posting the same event with the
 * same idempotency_key is a no-op — caller can safely retry.
 */

import { Router, Response } from 'express';
import {
  requireAuthWithTenant,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { emitOasisEvent } from '../services/oasis-event-service';
import {
  AWARENESS_EVENT_TO_TOPIC,
  type CapabilityAwarenessEventName,
} from '../services/assistant-continuation/telemetry';

const router = Router();
const VTID = 'VTID-03094';

const ALLOWED_EVENTS: ReadonlySet<CapabilityAwarenessEventName> = new Set([
  'introduced',
  'seen',
  'tried',
  'completed',
  'dismissed',
] as CapabilityAwarenessEventName[]);

const ALLOWED_SURFACES: ReadonlySet<string> = new Set([
  'orb_wake',
  'orb_turn_end',
  'text_turn_end',
  'home',
]);

const MAX_METADATA_KEYS = 16;
const MAX_STRING_FIELD_CHARS = 512;

router.post(
  '/voice/teacher/event',
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

      const capabilityKey =
        typeof body.capabilityKey === 'string' ? body.capabilityKey.trim() : '';
      const eventNameRaw =
        typeof body.eventName === 'string' ? body.eventName : '';
      const idempotencyKey =
        typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
      const decisionId =
        typeof body.decisionId === 'string' ? body.decisionId.trim() : null;
      const surfaceRaw =
        typeof body.sourceSurface === 'string' ? body.sourceSurface : undefined;
      const occurredAt =
        typeof body.occurredAt === 'string' && body.occurredAt
          ? body.occurredAt
          : new Date().toISOString();
      const metadata =
        body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
          ? (body.metadata as Record<string, unknown>)
          : undefined;

      // ---- Validation ----
      if (!capabilityKey) {
        return res
          .status(400)
          .json({ ok: false, error: 'capabilityKey is required', vtid: VTID });
      }
      if (capabilityKey.length > MAX_STRING_FIELD_CHARS) {
        return res
          .status(400)
          .json({ ok: false, error: 'capabilityKey too long', vtid: VTID });
      }
      if (!ALLOWED_EVENTS.has(eventNameRaw as CapabilityAwarenessEventName)) {
        return res.status(400).json({
          ok: false,
          error: `eventName must be one of: ${Array.from(ALLOWED_EVENTS).join(', ')}`,
          vtid: VTID,
        });
      }
      if (!idempotencyKey) {
        return res
          .status(400)
          .json({ ok: false, error: 'idempotencyKey is required', vtid: VTID });
      }
      if (idempotencyKey.length > MAX_STRING_FIELD_CHARS) {
        return res
          .status(400)
          .json({ ok: false, error: 'idempotencyKey too long', vtid: VTID });
      }
      if (decisionId && decisionId.length > MAX_STRING_FIELD_CHARS) {
        return res
          .status(400)
          .json({ ok: false, error: 'decisionId too long', vtid: VTID });
      }
      const sourceSurface =
        surfaceRaw && ALLOWED_SURFACES.has(surfaceRaw) ? surfaceRaw : null;
      if (metadata && Object.keys(metadata).length > MAX_METADATA_KEYS) {
        return res.status(400).json({
          ok: false,
          error: `metadata has more than ${MAX_METADATA_KEYS} keys`,
          vtid: VTID,
        });
      }

      const eventName = eventNameRaw as CapabilityAwarenessEventName;

      // ---- RPC ----
      const sb = getSupabase();
      if (!sb) {
        return res
          .status(503)
          .json({ ok: false, error: 'DB_UNAVAILABLE', vtid: VTID });
      }
      const { data: rpcResult, error: rpcError } = await sb.rpc(
        'advance_capability_awareness',
        {
          p_tenant_id: tenantId,
          p_user_id: userId,
          p_capability_key: capabilityKey,
          p_event_name: eventName,
          p_idempotency_key: idempotencyKey,
          p_decision_id: decisionId,
          p_source_surface: sourceSurface,
          p_occurred_at: occurredAt,
          p_metadata: metadata ?? null,
        },
      );
      if (rpcError) {
        console.warn(`[${VTID}] advance_capability_awareness failed: ${rpcError.message}`);
        return res.status(502).json({
          ok: false,
          error: 'rpc_failed',
          message: rpcError.message,
          vtid: VTID,
        });
      }
      const result =
        rpcResult && typeof rpcResult === 'object'
          ? (rpcResult as Record<string, unknown>)
          : {};
      if (result.ok === false) {
        return res.status(409).json({
          ok: false,
          error: 'transition_rejected',
          rpc_reason: result.reason,
          previous_state: result.previous_state,
          attempted_event: result.attempted_event ?? eventName,
          vtid: VTID,
        });
      }

      // ---- OASIS emit ----
      const topic = AWARENESS_EVENT_TO_TOPIC[eventName];
      try {
        await emitOasisEvent({
          vtid: VTID,
          type: topic as never,
          source: 'teacher-feature-discovery',
          status: 'info',
          message: topic,
          payload: {
            user_id: userId,
            tenant_id: tenantId,
            capability_key: capabilityKey,
            event_name: eventName,
            decision_id: decisionId,
            source_surface: sourceSurface,
            occurred_at: occurredAt,
            idempotent: result.idempotent === true,
            previous_state: result.previous_state ?? null,
            next_state: result.next_state ?? null,
            metadata: metadata ?? null,
          },
          actor_id: userId,
          actor_role: 'user',
          surface: 'orb',
        });
      } catch (emitErr) {
        // Telemetry MUST NOT fail the lifecycle write. The RPC has
        // already advanced state; emit is best-effort.
        console.warn(
          `[${VTID}] OASIS emit failed (non-fatal): ${(emitErr as Error).message}`,
        );
      }

      // ---- Navigation directive (introduced events with manual_path) ----
      let directive: Record<string, unknown> | null = null;
      if (eventName === 'introduced') {
        try {
          const { data: cap } = await sb
            .from('system_capabilities')
            .select('manual_path, display_name')
            .eq('capability_key', capabilityKey)
            .maybeSingle();
          if (cap && typeof cap === 'object') {
            const manualPath = (cap as { manual_path?: string | null }).manual_path;
            if (typeof manualPath === 'string' && manualPath.trim().length > 0) {
              directive = {
                type: 'orb_directive',
                directive: 'navigate',
                screen_id: 'MANUALS.PAGE',
                route: manualPath,
                title: (cap as { display_name?: string }).display_name ?? null,
                reason: 'teacher_introduced',
                vtid: VTID,
              };
            }
          }
        } catch {
          // manual_path lookup is best-effort.
        }
      }

      return res.status(200).json({
        ok: true,
        vtid: VTID,
        capability_key: capabilityKey,
        event_name: eventName,
        topic,
        idempotent: result.idempotent === true,
        previous_state: result.previous_state ?? null,
        next_state: result.next_state ?? null,
        event_id: result.event_id ?? null,
        directive,
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
