/**
 * VTID-02921 (B0e.2): central OASIS topic constants for the
 * assistant-continuation layer.
 *
 * Mirrors the pattern set by `orb/context/telemetry.ts` (B0b match-
 * journey topics): every event topic this module emits MUST come from
 * here, never from a raw string literal in the provider code.
 *
 * Why a central registry: when a future slice extends the provider
 * roster (B0d, reminders, opportunity-awareness, journey-guidance,
 * etc.), inconsistent topic names (`assistant.feature_discovery.offered`
 * vs `feature.discovery.offered` vs `assistant.continuation.feature_discovery.offered`)
 * silently break downstream rollups + Command Hub panels. The registry
 * makes the canonical name discoverable in one place.
 *
 * Naming follows the existing OASIS taxonomy (CLAUDE.md §6):
 *   - `assistant.continuation.*`        — continuation contract events (B0d)
 *   - `feature.discovery.*`             — feature-discovery product events (B0e)
 */

// ---------------------------------------------------------------------------
// Feature Discovery (B0e.2)
// ---------------------------------------------------------------------------

/** Provider returned a candidate (the ranker picked one). */
export const FEATURE_DISCOVERY_OFFERED   = 'feature.discovery.offered'   as const;
/** Provider suppressed (no eligible capability). */
export const FEATURE_DISCOVERY_SUPPRESSED = 'feature.discovery.suppressed' as const;
/** User accepted the offered capability (followed the CTA). */
export const FEATURE_DISCOVERY_ACCEPTED   = 'feature.discovery.accepted'   as const;
/** User dismissed the offered capability. */
export const FEATURE_DISCOVERY_DISMISSED  = 'feature.discovery.dismissed'  as const;
/** User completed the meaningful flow tied to the capability. */
export const FEATURE_DISCOVERY_COMPLETED  = 'feature.discovery.completed'  as const;

/**
 * Aggregate registry for the feature-discovery topic family. Future
 * grep guards (if scope expands) reference this list.
 */
export const FEATURE_DISCOVERY_TOPIC_REGISTRY = [
  FEATURE_DISCOVERY_OFFERED,
  FEATURE_DISCOVERY_SUPPRESSED,
  FEATURE_DISCOVERY_ACCEPTED,
  FEATURE_DISCOVERY_DISMISSED,
  FEATURE_DISCOVERY_COMPLETED,
] as const;

// ---------------------------------------------------------------------------
// Capability awareness state-advance events (B0e.4)
//
// Distinct family from feature.discovery.*:
//   feature.discovery.*   — provider lifecycle (offered/suppressed/etc.)
//   capability.awareness.* — user-state transitions on the ladder
//
// One event per state advance. The advance_capability_awareness() RPC
// is the ONLY mutation entrypoint; OASIS emission happens AFTER the
// transaction commits so a failed mutation never produces a stale
// state-advance event.
// ---------------------------------------------------------------------------

export const CAPABILITY_AWARENESS_INTRODUCED = 'capability.awareness.introduced' as const;
export const CAPABILITY_AWARENESS_SEEN       = 'capability.awareness.seen'       as const;
export const CAPABILITY_AWARENESS_TRIED      = 'capability.awareness.tried'      as const;
export const CAPABILITY_AWARENESS_COMPLETED  = 'capability.awareness.completed'  as const;
export const CAPABILITY_AWARENESS_DISMISSED  = 'capability.awareness.dismissed'  as const;
export const CAPABILITY_AWARENESS_MASTERED   = 'capability.awareness.mastered'   as const;

export type CapabilityAwarenessEventName =
  | 'introduced' | 'seen' | 'tried' | 'completed' | 'dismissed' | 'mastered';

export const CAPABILITY_AWARENESS_TOPIC_REGISTRY = [
  CAPABILITY_AWARENESS_INTRODUCED,
  CAPABILITY_AWARENESS_SEEN,
  CAPABILITY_AWARENESS_TRIED,
  CAPABILITY_AWARENESS_COMPLETED,
  CAPABILITY_AWARENESS_DISMISSED,
  CAPABILITY_AWARENESS_MASTERED,
] as const;

/**
 * Map an awareness event name to its OASIS topic constant. The service
 * MUST use this map — never construct topic strings inline.
 */
export const AWARENESS_EVENT_TO_TOPIC: Record<
  CapabilityAwarenessEventName,
  (typeof CAPABILITY_AWARENESS_TOPIC_REGISTRY)[number]
> = {
  introduced: CAPABILITY_AWARENESS_INTRODUCED,
  seen:       CAPABILITY_AWARENESS_SEEN,
  tried:      CAPABILITY_AWARENESS_TRIED,
  completed:  CAPABILITY_AWARENESS_COMPLETED,
  dismissed:  CAPABILITY_AWARENESS_DISMISSED,
  mastered:   CAPABILITY_AWARENESS_MASTERED,
};
