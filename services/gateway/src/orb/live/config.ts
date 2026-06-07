/**
 * A2 (orb-live-refactor): env-derived and lifecycle config constants.
 *
 * Lifted verbatim from services/gateway/src/routes/orb-live.ts.
 * Identical values + identical env fallbacks — no behavior change.
 * orb-live.ts now imports these instead of declaring them locally so
 * subsequent extraction steps (A7 upstream client, A8 session lifecycle)
 * share the same Vertex project/location resolution and lifecycle
 * timeouts.
 *
 * What lives here: top-level configuration that
 *   (a) reads process.env at module-load time, OR
 *   (b) sets a lifecycle/timing boundary the whole route file depends on.
 *
 * What does NOT live here: in-function env reads (those stay with their
 * function), CORS origin allow-lists (coupled with the CORS handler),
 * legacy `GEMINI_*` direct-API constants (legacy path, separate concern),
 * regex patterns for auth-intent detection (coupled with classifier).
 */

// VTID-01155: Vertex AI Live API configuration.
// Cloud Run does NOT auto-set GOOGLE_CLOUD_PROJECT env var, so we fall back
// to the hardcoded project ID. Same fallback as before the lift.
export const VERTEX_PROJECT_ID =
  process.env.GOOGLE_CLOUD_PROJECT
  || process.env.GCP_PROJECT_ID
  || 'lovable-vitana-vers1';

export const VERTEX_LOCATION = process.env.VERTEX_AI_LOCATION || 'us-central1';

/**
 * Live (ORB voice) session timeout. After 30 minutes of inactivity the
 * periodic session sweep purges the entry from `liveSessions`. SSE/WS
 * cleanup handlers handle the happy path; this is the safety net.
 */
export const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Conversation (text-chat) timeout. Conversations live longer than voice
 * sessions because text turns happen on human timescales.
 */
export const CONVERSATION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * ORB session-start idempotency (BOOTSTRAP-ORB-SESSION-CHURN).
 *
 * Telemetry (oasis_events, dev): 31.7% of `/live/session/start` calls supersede
 * a still-live session for the SAME user, and 89.5% of those superseded
 * sessions had ZERO turns — the greeting was torn down before it ever spoke
 * (the "constant disconnect during the opening" the community reports). The
 * superseding start lands within ~3.4s on average, so a redundant start (widget
 * re-show, double-mount, or a supersede→SSE-close→reconnect bounce) should
 * REUSE the in-flight zero-turn session instead of superseding it.
 *
 * The decision is STATE-driven, not clock-driven: a session is reusable while
 * it is `active` and has taken NO turns — that is the real signal, the same
 * greeting state a fresh session would be in. The age bound is only a safety
 * backstop so a wedged session can't be reused forever; it defaults to the
 * session TTL precisely because a zero-turn session stays in the identical
 * state for its whole life. Both are env-overridable so ops can tune the
 * backstop or flip the kill switch without a redeploy (defense-in-depth).
 */
export const ORB_SESSION_REUSE_ENABLED =
  (process.env.ORB_SESSION_REUSE_ENABLED ?? 'true').toLowerCase() !== 'false';

export const ORB_SESSION_REUSE_MAX_AGE_MS = (() => {
  const raw = Number(process.env.ORB_SESSION_REUSE_MAX_AGE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : SESSION_TIMEOUT_MS;
})();

/**
 * Maximum concurrent ORB connections from a single IP. Higher values
 * invite abuse; lower values break shared offices/NAT exits.
 */
export const MAX_CONNECTIONS_PER_IP = 5;

/**
 * Maximum auto-reconnects per session before the client is forced to
 * start a fresh session. 10 reconnects ≈ 50 minutes of session continuity.
 */
export const MAX_RECONNECTS = 10;

/**
 * Languages the Live API officially supports. New languages must land
 * here AND in the voice + greeting lookup tables.
 *
 * NOTE: typed as `string[]` (not `readonly ['en', 'de', ...]`) on purpose:
 * existing callsites pass arbitrary strings into `.includes()` for runtime
 * checks, and narrowing the type would force casts at every callsite.
 * A later cleanup can introduce a typed `SupportedLiveLanguage` union if
 * we want to refactor those callsites to a typed gate.
 */
export const SUPPORTED_LIVE_LANGUAGES: string[] = [
  'en',
  'de',
  'fr',
  'es',
  'ar',
  'zh',
  'sr',
  'ru',
];
