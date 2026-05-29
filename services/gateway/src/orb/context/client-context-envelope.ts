/**
 * B0a (orb-live-refactor): ClientContextEnvelope — the shared frontend ↔
 * gateway contract.
 *
 * Every UI surface (vitana-v1, Command Hub orb-widget, mobile WebView)
 * MUST populate this envelope on `POST /api/v1/orb/live/session/start`
 * (and on significant transitions: route change, surface handoff,
 * visibility change).
 *
 * The gateway parses + validates the envelope here, then feeds it to
 * `compileSituationalCore()` to produce the Tier 0 `SituationalCore`
 * signals that the context compiler (B0b) consumes.
 *
 * This module is the **single source of truth** for the envelope shape.
 * The vitana-v1 mirror lives at
 * `vitana-v1/src/shared/orb/clientContextEnvelope.ts` and must stay in
 * sync. The match-journey injection (2026-05-11) added `journeySurface`
 * to support 9 surfaces for the future activity-match concierge — see
 * `.claude/plans/for-an-intelligent-context-aware-fluttering-mango.md`
 * Match-Journey Hooks section.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// journeySurface — what kind of screen the user is on RIGHT NOW.
// ---------------------------------------------------------------------------
// Match-journey injection (2026-05-11): the 9 surfaces below must be
// populatable by the vitana-v1 populator and pass through the zod schema
// unchanged. B0a acceptance check #1 verifies the round-trip.

export const JOURNEY_SURFACE_VALUES = [
  'intent_board',
  'intent_card',
  'pre_match_whois',
  'match_detail',
  'match_chat',
  'activity_plan',
  'matches_hub',
  'notification_center',
  'command_hub',
  'unknown',
] as const;

export type JourneySurface = (typeof JOURNEY_SURFACE_VALUES)[number];

// ---------------------------------------------------------------------------
// ClientContextEnvelope — the shared contract.
// ---------------------------------------------------------------------------

export interface ClientContextEnvelope {
  /** Device surface (separate from journeySurface). */
  surface: 'mobile' | 'desktop' | 'command_hub' | 'unknown';

  /**
   * Journey surface — match-journey injection.
   * Populated by the vitana-v1 populator from the current React route.
   * Backend providers key off this enum, NOT the raw `route` string.
   */
  journeySurface?: JourneySurface;

  /** Raw React-Router path; kept for fallback + audit. */
  route?: string;

  /** IANA timezone, e.g. "Europe/Berlin". */
  timezone?: string;

  /** ISO 8601 timestamp with offset. */
  localNow?: string;

  wakeOrigin?:
    | 'orb_tap'
    | 'wake_word'
    | 'push_tap'
    | 'proactive_opener'
    | 'deep_link'
    | 'unknown';

  deviceClass?:
    | 'ios_webview'
    | 'android_webview'
    | 'desktop_browser'
    | 'command_hub'
    | 'unknown';

  visibilityState?: 'visible' | 'hidden' | 'prerender';

  networkRttMs?: number;

  location?: {
    lat?: number;
    lng?: number;
    accuracyMeters?: number;
    permissionState?: 'granted' | 'denied' | 'prompt' | 'unknown';
    /** ISO 8601 — used for freshness. */
    capturedAt?: string;
  };

  privacyMode?: 'private' | 'shared_device' | 'unknown';
}

// ---------------------------------------------------------------------------
// Zod schema — runtime validation at the gateway ingest boundary.
// ---------------------------------------------------------------------------
// The schema mirrors the TypeScript shape exactly. We use `.passthrough()`
// nowhere — `additional-properties: false` is the contract.

export const clientContextEnvelopeSchema = z.object({
  surface: z.enum(['mobile', 'desktop', 'command_hub', 'unknown']),
  journeySurface: z.enum(JOURNEY_SURFACE_VALUES).optional(),
  route: z.string().optional(),
  timezone: z.string().optional(),
  localNow: z.string().optional(),
  wakeOrigin: z
    .enum(['orb_tap', 'wake_word', 'push_tap', 'proactive_opener', 'deep_link', 'unknown'])
    .optional(),
  deviceClass: z
    .enum(['ios_webview', 'android_webview', 'desktop_browser', 'command_hub', 'unknown'])
    .optional(),
  visibilityState: z.enum(['visible', 'hidden', 'prerender']).optional(),
  networkRttMs: z.number().optional(),
  location: z
    .object({
      lat: z.number().optional(),
      lng: z.number().optional(),
      accuracyMeters: z.number().optional(),
      permissionState: z.enum(['granted', 'denied', 'prompt', 'unknown']).optional(),
      capturedAt: z.string().optional(),
    })
    .strict()
    .optional(),
  privacyMode: z.enum(['private', 'shared_device', 'unknown']).optional(),
}).strict();

/**
 * Parse an unknown payload as a `ClientContextEnvelope`.
 *
 * Returns `{ ok: true, envelope }` when the input matches the schema, or
 * `{ ok: false, error }` when it doesn't. Callers (the session-start
 * route, the Continuation Inspector preview endpoint) should treat
 * `ok: false` as a recoverable degradation — `compileSituationalCore`
 * tolerates a `null` envelope and emits a `client_envelope_completeness`
 * warning on the source-health panel.
 */
export function parseClientContextEnvelope(
  input: unknown,
): { ok: true; envelope: ClientContextEnvelope } | { ok: false; error: string } {
  const result = clientContextEnvelopeSchema.safeParse(input);
  if (result.success) {
    return { ok: true, envelope: result.data as ClientContextEnvelope };
  }
  return { ok: false, error: result.error.message };
}
