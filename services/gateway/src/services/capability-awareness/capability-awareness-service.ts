/**
 * VTID-02924 (B0e.4) — capability awareness state advancement service.
 *
 * The ONLY mutation surface for `user_capability_awareness`. Selection
 * (B0e.2) and preview (B0e.3) NEVER call this — they remain read-only.
 *
 * Calls the `advance_capability_awareness` Postgres RPC which:
 *   - Validates the transition against the 7-state ladder.
 *   - Enforces idempotency on (tenant_id, user_id, idempotency_key)
 *     via a UNIQUE constraint on capability_awareness_events.
 *   - Writes the audit log row + upserts user_capability_awareness
 *     atomically inside one transaction.
 *
 * Emits exactly one OASIS event per non-idempotent advance, using
 * topic constants from the central telemetry registry. NEVER emits
 * on idempotent replays or on rejected transitions.
 */

import { getSupabase } from '../../lib/supabase';
import { emitOasisEvent } from '../oasis-event-service';
import {
  AWARENESS_EVENT_TO_TOPIC,
  type CapabilityAwarenessEventName,
} from '../assistant-continuation/telemetry';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AwarenessState =
  | 'unknown'
  | 'introduced'
  | 'seen'
  | 'tried'
  | 'completed'
  | 'dismissed'
  | 'mastered';

export interface IngestCapabilityEventArgs {
  tenantId: string;
  userId: string;
  capabilityKey: string;
  eventName: CapabilityAwarenessEventName;
  /** REQUIRED. Duplicate keys do not double-advance. */
  idempotencyKey: string;
  /** Optional AssistantContinuationDecision.decisionId — links action to decision. */
  decisionId?: string;
  /** Which surface the event originated from. */
  sourceSurface?: 'orb_wake' | 'orb_turn_end' | 'text_turn_end' | 'home';
  /** ISO 8601. Defaults to now. */
  occurredAt?: string;
  metadata?: Record<string, unknown>;
}

export type IngestResult =
  | {
      ok: true;
      idempotent: boolean;
      previousState: AwarenessState;
      nextState: AwarenessState;
      eventId: string;
    }
  | {
      ok: false;
      reason:
        | 'unknown_capability'
        | 'transition_not_allowed'
        | 'identity_required'
        | 'idempotency_key_required'
        | 'event_name_invalid'
        | 'database_unavailable'
        | 'database_error';
      detail?: string;
      previousState?: AwarenessState;
    };

const ALLOWED_EVENT_NAMES: ReadonlySet<CapabilityAwarenessEventName> = new Set([
  'introduced', 'seen', 'tried', 'completed', 'dismissed', 'mastered',
]);

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface CapabilityAwarenessServiceOptions {
  /** Injected for tests. */
  getDb?: typeof getSupabase;
  /** Injected for tests — emit OASIS or no-op. */
  emit?: typeof emitOasisEvent;
}

export interface CapabilityAwarenessService {
  ingest(args: IngestCapabilityEventArgs): Promise<IngestResult>;
}

export function createCapabilityAwarenessService(
  opts: CapabilityAwarenessServiceOptions = {},
): CapabilityAwarenessService {
  const getDb = opts.getDb ?? getSupabase;
  const emit = opts.emit ?? emitOasisEvent;

  return {
    async ingest(args: IngestCapabilityEventArgs): Promise<IngestResult> {
      // ---- Input validation ----
      if (!args.tenantId || !args.userId) {
        return { ok: false, reason: 'identity_required' };
      }
      if (!args.idempotencyKey || args.idempotencyKey.trim().length === 0) {
        return { ok: false, reason: 'idempotency_key_required' };
      }
      if (!ALLOWED_EVENT_NAMES.has(args.eventName)) {
        return {
          ok: false,
          reason: 'event_name_invalid',
          detail: `event must be one of ${Array.from(ALLOWED_EVENT_NAMES).join(', ')}`,
        };
      }

      const sb = getDb();
      if (!sb) {
        return { ok: false, reason: 'database_unavailable' };
      }

      // ---- Invoke the atomic RPC ----
      let rpcResult: any;
      try {
        const { data, error } = await sb.rpc('advance_capability_awareness', {
          p_tenant_id: args.tenantId,
          p_user_id: args.userId,
          p_capability_key: args.capabilityKey,
          p_event_name: args.eventName,
          p_idempotency_key: args.idempotencyKey,
          p_decision_id: args.decisionId ?? null,
          p_source_surface: args.sourceSurface ?? null,
          p_occurred_at: args.occurredAt ?? null,
          p_metadata: args.metadata ?? null,
        });
        if (error) {
          return {
            ok: false,
            reason: 'database_error',
            detail: error.message,
          };
        }
        rpcResult = data;
      } catch (err) {
        return {
          ok: false,
          reason: 'database_error',
          detail: err instanceof Error ? err.message : String(err),
        };
      }

      // ---- Translate RPC envelope ----
      if (!rpcResult || typeof rpcResult !== 'object') {
        return {
          ok: false,
          reason: 'database_error',
          detail: 'RPC returned non-object envelope',
        };
      }

      if (rpcResult.ok === false) {
        const reason = rpcResult.reason;
        if (reason === 'unknown_capability') {
          return { ok: false, reason: 'unknown_capability' };
        }
        if (reason === 'transition_not_allowed') {
          return {
            ok: false,
            reason: 'transition_not_allowed',
            previousState: rpcResult.previous_state as AwarenessState,
            detail: `event=${args.eventName} not allowed from state=${rpcResult.previous_state}`,
          };
        }
        return {
          ok: false,
          reason: 'database_error',
          detail: `unexpected RPC reason: ${String(reason)}`,
        };
      }

      const result: IngestResult = {
        ok: true,
        idempotent: rpcResult.idempotent === true,
        previousState: rpcResult.previous_state as AwarenessState,
        nextState: rpcResult.next_state as AwarenessState,
        eventId: rpcResult.event_id as string,
      };

      // ---- Emit OASIS — only on a fresh advance, not idempotent replays ----
      if (!result.idempotent) {
        try {
          const topic = AWARENESS_EVENT_TO_TOPIC[args.eventName];
          await emit({
            type: topic,
            actor: args.userId,
            payload: {
              tenant_id: args.tenantId,
              user_id: args.userId,
              capability_key: args.capabilityKey,
              event_name: args.eventName,
              previous_state: result.previousState,
              next_state: result.nextState,
              decision_id: args.decisionId ?? null,
              source_surface: args.sourceSurface ?? null,
              event_id: result.eventId,
              idempotency_key: args.idempotencyKey,
              metadata: args.metadata ?? null,
            },
          } as never);
        } catch {
          // Telemetry never blocks state-advance; the audit log row is
          // the source of truth.
        }
      }

      return result;
    },
  };
}

export const defaultCapabilityAwarenessService = createCapabilityAwarenessService();
