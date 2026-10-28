/**
 * VTID-03061 (B0d-real slice Xf.1) — Next-Action OASIS event emitter.
 *
 * After the framework picks a B0d-real winner, the wake-brief wiring
 * calls this module to emit the OASIS suggested + per-source candidate
 * trail so the Command Hub Candidate Inspector (Xf.3) can render the
 * full decision later.
 *
 * Fire-and-forget by design — telemetry MUST NEVER block the voice
 * path. Every emit catches its own errors.
 *
 * What this slice emits:
 *   - `orb.livekit.next_action.suggested`  — once, when the framework
 *     selected a `contextual_next_action` continuation. Payload:
 *     {user_id, tenant_id, decision_id, source, priority, confidence,
 *      dedupe_key, reasons[]}.
 *   - `orb.livekit.next_action.candidate`  — once per source that
 *     RETURNED a candidate (winner + losers). Lets the Inspector show
 *     the full ranking.
 *   - `orb.livekit.next_action.suppressed` — once, when the provider
 *     returned `suppressed` (no winner). Payload: {suppress_reason}.
 *
 * The accepted / dismissed lifecycle (CTA followed vs ignored) emits
 * from a separate code path in Xf.2 — this slice covers the
 * decision-time signals only.
 */

import { emitOasisEvent } from '../../../oasis-event-service';
import {
  NEXT_ACTION_SUGGESTED,
  NEXT_ACTION_CANDIDATE,
  NEXT_ACTION_SUPPRESSED,
} from '../../telemetry';
import type { AssistantContinuation, AssistantContinuationDecision } from '../../types';
import type { NextActionSourceResult } from './types';

const VTID = 'VTID-03061' as const;
const VTID_PER_SOURCE = 'VTID-03066' as const;

export interface EmitNextActionDecisionInputs {
  decision: AssistantContinuationDecision;
  userId: string | null;
  tenantId: string | null;
  surface: 'orb_wake' | 'orb_turn_end';
}

/**
 * Emit the per-decision next-action OASIS trail. Reads from the
 * framework's standard decision carrier — no NextAction-specific
 * internals leak here, so a future provider that swaps internals
 * still produces the same OASIS shape.
 *
 * The function returns immediately; emits are fired in the background.
 * Callers do NOT await individual emits.
 */
export function emitNextActionDecisionTelemetry(
  inputs: EmitNextActionDecisionInputs,
): void {
  try {
    const { decision, userId, tenantId, surface } = inputs;

    const winner = decision.selectedContinuation;
    const isB0dRealWinner =
      winner !== null && isContextualNextActionContinuation(winner);

    // Always emit candidate rows for the per-source results that were
    // produced INSIDE the next-action provider. The provider returns ONE
    // candidate to the framework (the winner); the framework's
    // sourceProviderResults only shows the provider-level row, not the
    // per-source slate. To preserve full visibility, we surface the
    // winner's per-source evidence via the suggested event.
    if (isB0dRealWinner) {
      void safeEmit({
        topic: NEXT_ACTION_SUGGESTED,
        payload: {
          user_id: userId,
          tenant_id: tenantId,
          surface,
          decision_id: decision.decisionId,
          continuation_id: winner.id,
          dedupe_key: winner.dedupeKey,
          priority: winner.priority,
          source_evidence: pickSourceEvidence(winner),
          reason_evidence: pickReasonEvidence(winner),
          user_facing_line_chars: winner.userFacingLine.length,
          decision_started_at: decision.decisionStartedAt,
          decision_finished_at: decision.decisionFinishedAt,
        },
        actorId: userId,
      });
      // Mirror under the .candidate topic too so a future Inspector
      // query can grep one family rather than two.
      void safeEmit({
        topic: NEXT_ACTION_CANDIDATE,
        payload: {
          user_id: userId,
          tenant_id: tenantId,
          decision_id: decision.decisionId,
          winner: true,
          dedupe_key: winner.dedupeKey,
          source_evidence: pickSourceEvidence(winner),
        },
        actorId: userId,
      });
      return;
    }

    // No B0d-real winner. Emit a suppressed row so the inspector can
    // see *that* the next-action layer ran and chose nothing — vs the
    // case where the provider wasn't even consulted (which the
    // framework's sourceProviderResults already covers).
    const nextActionProviderRow = decision.sourceProviderResults.find(
      (r) => r.providerKey === 'contextual_next_action',
    );
    if (nextActionProviderRow && nextActionProviderRow.status !== 'returned') {
      void safeEmit({
        topic: NEXT_ACTION_SUPPRESSED,
        payload: {
          user_id: userId,
          tenant_id: tenantId,
          surface,
          decision_id: decision.decisionId,
          provider_status: nextActionProviderRow.status,
          suppress_reason: nextActionProviderRow.reason ?? null,
          latency_ms: nextActionProviderRow.latencyMs,
        },
        actorId: userId,
      });
    }
  } catch {
    // Never propagate telemetry errors upward.
  }
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

/**
 * Whether the continuation was emitted by the B0d-real Contextual Next
 * Action provider (vs the voice-wake-brief fallback). The provider key
 * is encoded into the rendered candidate's evidence as `source:<key>`
 * (see index.ts:renderCandidateAsContinuation).
 */
export function isContextualNextActionContinuation(
  c: AssistantContinuation,
): boolean {
  return c.evidence.some((e) => e.kind.startsWith('source:'));
}

export function pickSourceEvidence(
  c: AssistantContinuation,
): { kind: string; detail: string } | null {
  const sourceEv = c.evidence.find((e) => e.kind.startsWith('source:'));
  if (!sourceEv) return null;
  return { kind: sourceEv.kind, detail: sourceEv.detail };
}

export function pickReasonEvidence(
  c: AssistantContinuation,
): Array<{ kind: string; detail: string }> {
  return c.evidence
    .filter((e) => !e.kind.startsWith('source:'))
    .map((e) => ({ kind: e.kind, detail: e.detail }));
}

interface SafeEmitArgs {
  topic: string;
  payload: Record<string, unknown>;
  actorId: string | null;
  vtidOverride?: string;
}

async function safeEmit(args: SafeEmitArgs): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: args.vtidOverride ?? VTID,
      // The OASIS event service uses `type` for the event topic name.
      type: args.topic as never,
      source: 'b0d-real-next-action',
      status: 'info',
      message: args.topic,
      payload: args.payload,
      actor_id: args.actorId ?? undefined,
      actor_role: 'user',
      surface: 'orb',
    });
  } catch {
    // Telemetry must never break the voice path.
  }
}

// ---------------------------------------------------------------------------
// VTID-03066 (B0d-real Xi) — per-source candidate emit
//
// Fires from inside the next-action provider's produce() BEFORE the
// framework's emit-telemetry runs. Decision_id isn't known yet (the
// framework hasn't returned), so per-source rows carry `compose_id`
// instead — a uuid generated by the provider that groups all source
// rows from the same compose() invocation. The Inspector can join
// compose_id ↔ decision_id by time window + user_id when needed.
//
// Each emit is fire-and-forget. Never blocks the voice path.
// ---------------------------------------------------------------------------

export interface PerSourceEmitInputs {
  composeId: string;
  userId: string;
  tenantId: string;
  surface: 'orb_wake' | 'orb_turn_end';
  candidates: ReadonlyArray<NextActionSourceResult>;
  /** Source key that won (so per-source rows can tag `winner: true`). */
  winnerSource: string | null;
}

/**
 * Emit one `orb.livekit.next_action.candidate` row per source result.
 * Includes priority + confidence + dedupeKey for winners, and
 * skippedReason + latency for non-winners.
 */
export function emitPerSourceCandidates(inputs: PerSourceEmitInputs): void {
  try {
    for (const row of inputs.candidates) {
      void safeEmit({
        topic: NEXT_ACTION_CANDIDATE,
        vtidOverride: VTID_PER_SOURCE,
        payload: {
          compose_id: inputs.composeId,
          user_id: inputs.userId,
          tenant_id: inputs.tenantId,
          surface: inputs.surface,
          source: row.source,
          status: row.candidate ? 'returned' : 'skipped',
          winner: inputs.winnerSource === row.source,
          priority: row.candidate?.priority ?? null,
          confidence: row.candidate?.confidence ?? null,
          dedupe_key: row.candidate?.dedupeKey ?? null,
          skipped_reason: row.skippedReason ?? null,
          latency_ms: row.latencyMs ?? null,
        },
        actorId: inputs.userId,
      });
    }
  } catch {
    // Telemetry must never break the voice path.
  }
}
