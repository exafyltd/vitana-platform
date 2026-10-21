/**
 * VTID-03210 — Turn-1 wake-decision observability snapshot.
 *
 * PURPOSE (observability only — ZERO behavior change):
 * The ORB's first spoken turn is decided by a fan-out of providers
 * (contextual_next_action / new_day_return / feature_discovery_teacher /
 * voice_wake_brief) whose ranking + suppression evidence, the set of
 * turn-1 prompt blocks that end up co-present (wakeBriefOverride /
 * teacherModeContent / journeyGreeting), the resolved first name + its
 * source, and the transport (Vertex vs LiveKit) are currently scattered
 * across several independent `console.log` lines per VTID. That makes two
 * production questions hard to answer from logs:
 *
 *   1. ALLOWLIST MASKING — is a given user actually on Vertex or LiveKit?
 *      (a single `transport` field per session answers this.)
 *   2. TURN-1 BLOCK COLLISION — does the Vertex prompt carry the legacy
 *      greeting policy + a verbatim wake-brief override + a journey
 *      greeting block at the same time? (`turn1_collision` flags it.)
 *
 * This module emits ONE structured line per session, identically on both
 * transports, so the turn-1 state machine becomes observable at a glance.
 * It performs NO IO, mutates nothing, and is safe to call on every wake.
 */

import type { AssistantContinuationDecision } from '../../../services/assistant-continuation/types';

export type WakeTransport = 'vertex' | 'livekit';

/** Which source resolved the first name (precedence is path-specific). */
export type FirstNameSource =
  | 'memory_facts'
  | 'app_users'
  | 'email'
  | 'none'
  | 'unknown';

export interface WakeDecisionSnapshotInput {
  transport: WakeTransport;
  sessionId: string;
  /** The wake-brief decision carrier, or null when the decision threw. */
  decision: AssistantContinuationDecision | null;
  /** Presence of each turn-1 prompt block on the session at emit time. */
  blocks: {
    wakeBriefOverride: boolean;
    teacherModeContent: boolean;
    journeyGreeting: boolean;
  };
  firstName: { value: string | null; source: FirstNameSource };
  lang: string;
  bucket?: string | null;
  isReconnect?: boolean;
  timezonePresent?: boolean;
}

export interface WakeDecisionSnapshot {
  tag: 'wake_decision';
  transport: WakeTransport;
  session_id: string;
  decision_id: string | null;
  winner: {
    provider_key: string;
    kind: string;
    source_kind: string | null;
    dedupe_key: string | null;
    line_present: boolean;
    line_chars: number;
  } | null;
  /** Rolled-up reason when no provider returned a candidate. */
  suppression_reason: string | null;
  /** One row per provider invoked — suppressed/errored rows included. */
  providers: Array<{
    key: string;
    status: string;
    reason: string | null;
    latency_ms: number;
  }>;
  turn1_blocks: {
    wake_brief_override: boolean;
    teacher_mode_content: boolean;
    journey_greeting: boolean;
  };
  turn1_block_count: number;
  /** True when ≥2 turn-1 blocks are simultaneously present (drift hazard). */
  turn1_collision: boolean;
  first_name: { present: boolean; source: FirstNameSource; len: number };
  lang: string;
  bucket: string | null;
  is_reconnect: boolean;
  timezone_present: boolean;
}

const STRUCTURED_LOG_PREFIX = '[wake-decision]';

/** Pure: derive the source kind (`source:*` evidence) from the winner. */
function deriveSourceKind(
  decision: AssistantContinuationDecision | null,
): string | null {
  const selected = decision?.selectedContinuation;
  if (!selected || selected.kind === 'none_with_reason') return null;
  const evidence = selected.evidence ?? [];
  const sourced = evidence.find((e) => e.kind?.startsWith('source:'));
  return sourced?.kind ?? null;
}

/**
 * Pure: map the winning candidate back to the provider key that produced
 * it, by matching on dedupeKey within sourceProviderResults. Falls back to
 * the source kind, then the candidate kind.
 */
function deriveWinnerProviderKey(
  decision: AssistantContinuationDecision | null,
): string {
  const selected = decision?.selectedContinuation;
  if (!selected) return 'none';
  const match = (decision?.sourceProviderResults ?? []).find(
    (r) => r.status === 'returned' && r.candidate?.dedupeKey === selected.dedupeKey,
  );
  if (match) return match.providerKey;
  return deriveSourceKind(decision) ?? selected.kind;
}

/** Pure builder — no IO, no clock, no mutation. Safe to unit-test. */
export function buildWakeDecisionSnapshot(
  input: WakeDecisionSnapshotInput,
): WakeDecisionSnapshot {
  const { decision } = input;
  const selected = decision?.selectedContinuation ?? null;
  const hasRealWinner = !!selected && selected.kind !== 'none_with_reason';

  const blockCount =
    (input.blocks.wakeBriefOverride ? 1 : 0) +
    (input.blocks.teacherModeContent ? 1 : 0) +
    (input.blocks.journeyGreeting ? 1 : 0);

  const line = selected?.userFacingLine?.trim() ?? '';

  return {
    tag: 'wake_decision',
    transport: input.transport,
    session_id: input.sessionId,
    decision_id: decision?.decisionId ?? null,
    winner: hasRealWinner
      ? {
          provider_key: deriveWinnerProviderKey(decision),
          kind: selected!.kind,
          source_kind: deriveSourceKind(decision),
          dedupe_key: selected!.dedupeKey ?? null,
          line_present: line.length > 0,
          line_chars: line.length,
        }
      : null,
    suppression_reason: hasRealWinner
      ? null
      : decision?.suppressionReason ??
        (selected?.kind === 'none_with_reason'
          ? selected.suppressReason ?? null
          : null),
    providers: (decision?.sourceProviderResults ?? []).map((r) => ({
      key: r.providerKey,
      status: r.status,
      reason: r.reason ?? null,
      latency_ms: r.latencyMs,
    })),
    turn1_blocks: {
      wake_brief_override: input.blocks.wakeBriefOverride,
      teacher_mode_content: input.blocks.teacherModeContent,
      journey_greeting: input.blocks.journeyGreeting,
    },
    turn1_block_count: blockCount,
    turn1_collision: blockCount >= 2,
    first_name: {
      present: !!input.firstName.value,
      source: input.firstName.source,
      len: input.firstName.value?.length ?? 0,
    },
    lang: input.lang,
    bucket: input.bucket ?? null,
    is_reconnect: !!input.isReconnect,
    timezone_present: !!input.timezonePresent,
  };
}

/**
 * Emit the snapshot as one structured JSON line. Stable prefix so Cloud
 * Run / Management-API log queries can `grep '[wake-decision]'` and parse
 * the JSON. Never throws — observability must not break the voice path.
 */
export function logWakeDecisionSnapshot(
  input: WakeDecisionSnapshotInput,
): WakeDecisionSnapshot {
  const snapshot = buildWakeDecisionSnapshot(input);
  try {
    // eslint-disable-next-line no-console
    console.log(`${STRUCTURED_LOG_PREFIX} ${JSON.stringify(snapshot)}`);
  } catch {
    // Serialization must never break the session.
  }
  return snapshot;
}
