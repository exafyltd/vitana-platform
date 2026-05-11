/**
 * B0a (orb-live-refactor): Situational Awareness Core — Tier 0 signals.
 *
 * Takes a `ClientContextEnvelope` (parsed at the session-start route)
 * and emits a typed `SituationalCore` object that the context compiler
 * (B0b) consumes as one of its highest-priority inputs.
 *
 * Tier 0 = synchronous or hot-cache-only. No DB reads, no external
 * APIs, no async waits. Compilation must complete inside the voice-start
 * latency budget so the ORB never blocks on situational signals.
 *
 * Signals derived here (per the approved plan, Category L):
 *   - day_part_label              (from local time + timezone)
 *   - daylight_phase              (from local time + month, approximate)
 *   - location_freshness_confidence (from envelope.location.capturedAt age)
 *   - device_class                (from envelope.deviceClass)
 *   - privacy_speaking_mode       (from envelope.privacyMode)
 *   - current_route + journey_surface (from envelope.route + journeySurface)
 *   - client_envelope_completeness (which envelope fields the UI sent vs missing)
 *
 * Match-journey injection note: `journeySurface` is carried through
 * verbatim. This module does NOT interpret match semantics — that's the
 * job of `orb/context/providers/match-journey-context-provider.ts` (B0b).
 * Here we only surface the fact "the user is on intent_board" without
 * deciding what to do about it.
 */

import type { ClientContextEnvelope, JourneySurface } from './client-context-envelope';

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type DayPartLabel = 'morning' | 'afternoon' | 'evening' | 'night' | 'late_night' | 'unknown';

export type DaylightPhase =
  | 'pre_dawn'
  | 'morning'
  | 'midday'
  | 'afternoon'
  | 'golden_hour'
  | 'dusk'
  | 'night'
  | 'late_night'
  | 'unknown';

export type LocationFreshnessConfidence = 'high' | 'low' | 'unknown';

export type PrivacySpeakingMode = 'private' | 'shared_device' | 'unknown';

export interface SituationalCore {
  dayPartLabel: DayPartLabel;
  daylightPhase: DaylightPhase;
  locationFreshnessConfidence: LocationFreshnessConfidence;
  deviceClass: ClientContextEnvelope['deviceClass'] | 'unknown';
  privacySpeakingMode: PrivacySpeakingMode;
  /** Raw React-Router path (for audit + fallback). */
  currentRoute: string | null;
  /** Match-journey injection: which kind of screen the user is on. Always present (defaults to 'unknown'). */
  journeySurface: JourneySurface;
  /**
   * Which envelope fields the UI did NOT send. Powers the source-health
   * panel's degradation signals and the `assistant.context_source_degraded`
   * OASIS event.
   */
  envelopeCompleteness: {
    surfaceMissing: boolean;
    journeySurfaceMissing: boolean;
    routeMissing: boolean;
    timezoneMissing: boolean;
    localNowMissing: boolean;
    deviceClassMissing: boolean;
    privacyModeMissing: boolean;
    locationMissing: boolean;
    locationStale: boolean;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Location data older than this is treated as "low confidence". */
const LOCATION_FRESHNESS_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compile Tier 0 situational core from the envelope.
 *
 * `nowMs` is injectable for testability (and to avoid `Date.now()`
 * coupling). Production callers pass `Date.now()`.
 *
 * Tolerates a `null` envelope — the function returns a degraded-but-
 * typed `SituationalCore` with `envelopeCompleteness` flags all set to
 * `true`. The compiler MUST handle this gracefully.
 */
export function compileSituationalCore(
  envelope: ClientContextEnvelope | null,
  nowMs: number,
): SituationalCore {
  if (!envelope) {
    return emptySituationalCore();
  }

  const dayPartLabel = deriveDayPartLabel(envelope.localNow);
  const daylightPhase = deriveDaylightPhase(envelope.localNow);
  const locationFreshnessConfidence = deriveLocationFreshness(envelope, nowMs);

  return {
    dayPartLabel,
    daylightPhase,
    locationFreshnessConfidence,
    deviceClass: envelope.deviceClass ?? 'unknown',
    privacySpeakingMode: envelope.privacyMode ?? 'unknown',
    currentRoute: envelope.route ?? null,
    journeySurface: envelope.journeySurface ?? 'unknown',
    envelopeCompleteness: {
      surfaceMissing: !envelope.surface || envelope.surface === 'unknown',
      journeySurfaceMissing: !envelope.journeySurface || envelope.journeySurface === 'unknown',
      routeMissing: !envelope.route,
      timezoneMissing: !envelope.timezone,
      localNowMissing: !envelope.localNow,
      deviceClassMissing: !envelope.deviceClass || envelope.deviceClass === 'unknown',
      privacyModeMissing: !envelope.privacyMode || envelope.privacyMode === 'unknown',
      locationMissing: !envelope.location,
      locationStale: isLocationStale(envelope, nowMs),
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function emptySituationalCore(): SituationalCore {
  return {
    dayPartLabel: 'unknown',
    daylightPhase: 'unknown',
    locationFreshnessConfidence: 'unknown',
    deviceClass: 'unknown',
    privacySpeakingMode: 'unknown',
    currentRoute: null,
    journeySurface: 'unknown',
    envelopeCompleteness: {
      surfaceMissing: true,
      journeySurfaceMissing: true,
      routeMissing: true,
      timezoneMissing: true,
      localNowMissing: true,
      deviceClassMissing: true,
      privacyModeMissing: true,
      locationMissing: true,
      locationStale: true,
    },
  };
}

function deriveDayPartLabel(localNow: string | undefined): DayPartLabel {
  if (!localNow) return 'unknown';
  const hour = extractLocalHour(localNow);
  if (hour === null) return 'unknown';
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  if (hour >= 22 || hour < 2) return 'night';
  return 'late_night'; // 2-5am
}

function deriveDaylightPhase(localNow: string | undefined): DaylightPhase {
  if (!localNow) return 'unknown';
  const hour = extractLocalHour(localNow);
  if (hour === null) return 'unknown';
  // Coarse approximation — proper sunrise/sunset tables ship in B8 (K-category).
  if (hour >= 4 && hour < 6) return 'pre_dawn';
  if (hour >= 6 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 15) return 'midday';
  if (hour >= 15 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 20) return 'golden_hour';
  if (hour >= 20 && hour < 22) return 'dusk';
  if (hour >= 22 || hour < 2) return 'night';
  return 'late_night';
}

function extractLocalHour(localNow: string): number | null {
  // ISO 8601 — parse hour from the string directly to honor the offset
  // the client sent. Avoid `new Date()` which would interpret the offset
  // and convert to host time.
  const match = /T(\d{2}):/.exec(localNow);
  if (!match) return null;
  const h = parseInt(match[1], 10);
  return Number.isFinite(h) && h >= 0 && h < 24 ? h : null;
}

function deriveLocationFreshness(
  envelope: ClientContextEnvelope,
  nowMs: number,
): LocationFreshnessConfidence {
  if (!envelope.location?.capturedAt) return 'unknown';
  const capturedMs = Date.parse(envelope.location.capturedAt);
  if (!Number.isFinite(capturedMs)) return 'unknown';
  const ageMs = nowMs - capturedMs;
  return ageMs < LOCATION_FRESHNESS_THRESHOLD_MS ? 'high' : 'low';
}

function isLocationStale(envelope: ClientContextEnvelope, nowMs: number): boolean {
  if (!envelope.location?.capturedAt) return true;
  const capturedMs = Date.parse(envelope.location.capturedAt);
  if (!Number.isFinite(capturedMs)) return true;
  return nowMs - capturedMs >= LOCATION_FRESHNESS_THRESHOLD_MS;
}
