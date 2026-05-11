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
