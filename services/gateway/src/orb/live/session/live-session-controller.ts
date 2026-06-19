/**
 * Session lifecycle controller for the ORB voice path.
 *
 * A8 is split per the spec's risk warning:
 *   A8.1 (shipped) — registry shell (Maps + types).
 *   A8.2 (shipped) — lifecycle/cleanup helpers + smallest session-action
 *                    handler (`/live/stream/end-turn`). Established the
 *                    deps-bag pattern.
 *   A8.2.1 (this)  — lift `/live/session/start` into the controller using
 *                    the same deps-bag pattern.
 *   A8.2.2 (next)  — lift `/live/session/stop`.
 *   A8.2.3 (next)  — lift `/live/stream/send`.
 *   A8.3 (after)   — LiveAPI message-handler closure migration to
 *                    VertexLiveClient (A7); migrate per-event SSE writes to
 *                    `writeSseEvent` from A9.2.
 *
 * Hard rules (carried from A7 / A9.1 / A9.2 / A8.1 / A8.2):
 *   1. Zero behavior change. The lifted helpers operate on the SAME Map
 *      instances that orb-live.ts mutates, via the A8.1 registry.
 *   2. Deps are injected once via `configureLiveSessionController`. Helpers
 *      that read deps after configuration call `getDeps()`. Configuring twice
 *      is an explicit error.
 *   3. No LiveAPI message-handler closure here — that's A8.3.
 *   4. No LiveKit adapter, no provider selection — L-lane work.
 */

import type { Response } from 'express';
import type WebSocket from 'ws';
import WebSocketPkg from 'ws';
import { randomUUID } from 'crypto';
import type {
  AuthenticatedRequest,
  SupabaseIdentity,
} from '../../../middleware/auth-supabase-jwt';
import type { GeminiLiveSession } from '../../../routes/orb-live';
import type {
  ClientContext,
  LiveSessionStartRequest,
  LiveStreamMessage,
  LiveStreamVideoFrame,
} from '../types';
import type { ContextPack } from '../../../types/conversation';
import { SESSION_TIMEOUT_MS, VERTEX_PROJECT_ID } from '../config';
import { VERTEX_LIVE_MODEL } from '../protocol';
import {
  // VTID-03124 (Phase D.1): voice thresholds now resolved via PolicyResolver.
  getVadSilenceDurationMs,
  getPostTurnCooldownMs,
  getForwardingAckTimeoutMs,
} from '../../upstream/constants';
import { destroySessionBuffer } from '../../../services/session-memory-buffer';
// VTID-03107: Live AI voice quota check at session start + per-minute meter.
import {
  reserveVoiceQuotaAtSessionStart,
  recordVoiceMinute,
  triggerDowngrade,
} from '../../../services/voice-quota-guard';
import { recordPaywallEvent } from '../../../services/entitlement-service';
// ORB-FAST-START Phase 2: defer wake-brief + journey off the session/start
// response path (flag-gated; default off → legacy inline behavior).
import { shouldDeferWakeWork, composeContextReady } from './orb-fast-start';

// VTID-03107: per-session voice-meter intervals. Keyed by session_id so cleanup
// in handleLiveSessionStop can tear down without touching GeminiLiveSession's type.
const voiceMeterIntervals: Map<string, NodeJS.Timeout> = new Map();
const VOICE_METER_INTERVAL_MS = 60_000; // 1 minute
import {
  deduplicatedExtract,
  clearExtractionState,
} from '../../../services/extraction-dedup-manager';
import {
  DEV_IDENTITY,
  fetchRecentConversationForCognee,
} from '../../../services/orb-memory-bridge';
import { emitOasisEvent } from '../../../services/oasis-event-service';
import { defaultWakeTimelineRecorder } from '../../../services/wake-timeline/wake-timeline-recorder';
import { decideWakeBriefForSession } from '../../../services/wake-brief-wiring';
// VTID-03255 — write a Journey Foundation session summary at session end.
import { createClient as createJourneySupabaseClient } from '@supabase/supabase-js';
import { recordJourneySessionSummary } from '../../../services/journey-foundation/session-summary-writer';
import { buildJourneyFoundationSnapshot } from '../../../services/journey-foundation/journey-foundation-state';
// VTID-03210: single structured turn-1 wake-decision observability line.
import {
  logWakeDecisionSnapshot,
  type FirstNameSource,
} from '../instruction/wake-decision-snapshot';
// VTID-03248 (R1 slice 1): single canonical spoken-first-name resolver.
import { resolveSpokenFirstName } from '../../../services/awareness-unified-context';
// DEV-COMHU-0513 (new-day): gate the fast greeting-facts pre-fetch on the
// EXISTING ORB_SAFE_FAST_GREETING feature flag (no new flag).
import { isFeatureLive } from '../../../services/feature-flags';
import { recordAgentHeartbeat } from '../../../routes/agents-registry';
import {
  fetchAdminBriefingBlock,
  isAdminRole,
} from '../../../services/admin-scanners/briefing';
import { dispatchVoiceFailureFireAndForget } from '../../../services/voice-self-healing-adapter';
import { cogneeExtractorClient } from '../../../services/cognee-extractor-client';
import {
  sessions,
  liveSessions,
  wsClientSessions,
} from './live-session-registry';

/**
 * Dependencies that live as locals inside `routes/orb-live.ts` and which
 * the lifted helpers need. Passed in once via
 * `configureLiveSessionController` so the controller module has no
 * runtime import cycle with orb-live.ts.
 *
 * Each dep maps 1:1 to a private function in orb-live.ts. Future slices
 * (A8.3 and beyond) may lift these out independently — until then the
 * deps-bag is the seam.
 */
export interface BootstrapContextResult {
  contextInstruction?: string;
  contextPack?: ContextPack;
  latencyMs?: number;
  skippedReason?: string;
}

export interface LiveSessionControllerDeps {
  // A8.2 — used by cleanupWsSession + handleLiveStreamEndTurn
  resolveOrbIdentity: (req: AuthenticatedRequest) => Promise<SupabaseIdentity | null>;
  clearResponseWatchdog: (session: GeminiLiveSession) => void;
  sendEndOfTurn: (ws: WebSocket) => boolean;

  // A8.2.1 — used by handleLiveSessionStart
  validateOrigin: (req: AuthenticatedRequest) => boolean;
  buildClientContext: (req: AuthenticatedRequest) => Promise<ClientContext>;
  normalizeLang: (lang: string) => string;
  getVoiceForLang: (lang: string) => string;
  getStoredLanguagePreference: (tenantId: string, userId: string) => Promise<string | null>;
  persistLanguagePreference: (tenantId: string, userId: string, lang: string) => void;
  fetchLastSessionInfo: (
    userId: string,
  ) => Promise<{ time: string; wasFailure: boolean } | null>;
  fetchOnboardingCohortBlock: (
    userId: string | null | undefined,
  ) => Promise<string>;
  buildBootstrapContextPack: (
    identity: SupabaseIdentity,
    sessionId: string,
  ) => Promise<BootstrapContextResult>;
  resolveEffectiveRole: (
    userId: string,
    tenantId: string,
  ) => Promise<string | null>;
  terminateExistingSessionsForUser: (
    userId: string,
    excludeSessionId?: string,
  ) => number;
  /**
   * Computes a temporal "time-since-last-session" bucket. Lives in
   * `orb/live/instruction/live-system-instruction.ts` but is passed
   * through the deps bag (instead of imported directly) because that
   * module imports `routes/orb-live.ts`, which would form a circular
   * import at module-load against the controller.
   */
  describeTimeSince: (
    lastSessionInfo: { time: string; wasFailure: boolean } | null | undefined,
  ) => { bucket: string; wasFailure: boolean };
  emitLiveSessionEvent: (
    eventType:
      | 'vtid.live.session.start'
      | 'vtid.live.session.stop'
      | 'vtid.live.audio.in.chunk'
      | 'vtid.live.video.in.frame'
      | 'vtid.live.audio.out.chunk'
      | 'orb.live.config_missing'
      | 'orb.live.connection_failed'
      | 'orb.live.stall_detected'
      | 'orb.live.diag'
      | 'orb.live.fallback_used'
      | 'orb.live.fallback_error'
      | 'orb.live.tool_loop_guard_activated'
      | 'orb.live.greeting.delivered',
    payload: Record<string, unknown>,
    status?: 'info' | 'warning' | 'error',
  ) => Promise<void>;

  // A8.2-complete — used by handleLiveStreamSend
  /** Forwards a base64 audio chunk to the upstream Vertex Live WS. */
  sendAudioToLiveAPI: (ws: WebSocket, audioB64: string, mimeType: string) => boolean;
  /** Arms the response watchdog. Body lives in orb-live.ts. */
  startResponseWatchdog: (
    session: GeminiLiveSession,
    timeoutMs: number,
    reason: string,
  ) => void;
  /** Lightweight pipeline diag — fires an OASIS event with session snapshot. */
  emitDiag: (
    session: GeminiLiveSession,
    stage: string,
    extra?: Record<string, unknown>,
  ) => void;
  /**
   * Reports whether the gateway's Google Auth client initialized at startup.
   * Used by stream/send's no-Live-API fallback log line. Exposed as a getter
   * so the controller never holds a stale snapshot.
   */
  getGoogleAuthReady: () => boolean;
}

let configuredDeps: LiveSessionControllerDeps | null = null;

/**
 * Wire orb-live.ts locals into the controller. MUST be called exactly
 * once at gateway module-load before any handler fires.
 */
export function configureLiveSessionController(deps: LiveSessionControllerDeps): void {
  if (configuredDeps) {
    throw new Error('live-session-controller already configured');
  }
  configuredDeps = deps;
}

/**
 * Test-only escape hatch. Production never calls this. Lets tests start
 * with a clean slate without mutating module state across tests.
 */
export function __resetLiveSessionControllerForTests(): void {
  configuredDeps = null;
}

function getDeps(): LiveSessionControllerDeps {
  if (!configuredDeps) {
    throw new Error('live-session-controller not configured — call configureLiveSessionController() at boot');
  }
  return configuredDeps;
}

// =============================================================================
// Lifecycle / cleanup helpers
// =============================================================================

/**
 * Sweep expired legacy `OrbLiveSession` entries. Originally inline in
 * orb-live.ts (line ~8384) with a `setInterval(..., 5 * 60 * 1000)`.
 *
 * orb-live.ts now imports this + still owns the `setInterval` schedule
 * so reload order is unchanged. Body is byte-identical to the legacy.
 */
export function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastActivity.getTime() > SESSION_TIMEOUT_MS) {
      console.log(`[ORB-LIVE] Session expired: ${sessionId}`);
      if (session.sseResponse) {
        try {
          session.sseResponse.end();
        } catch (e) {
          // Ignore
        }
      }
      sessions.delete(sessionId);
    }
  }
}

/**
 * Close + clean up a WebSocket client session. Originally inline at
 * orb-live.ts:~13931.
 *
 * Behavior parity:
 *   - VTID-01230 deduplicated extraction on disconnect if transcript exists.
 *   - VTID-STREAM-KEEPALIVE: clears upstream ping + silence keepalive intervals.
 *   - VTID-WATCHDOG: clears the response watchdog.
 *   - Closes upstream Vertex WS if open; closes client WS with code 1000.
 *   - Removes the entry from both `liveSessions` and `wsClientSessions`.
 */
export function cleanupWsSession(sessionId: string): void {
  const deps = getDeps();
  const clientSession = wsClientSessions.get(sessionId);
  if (!clientSession) return;

  // Close Live API session if active
  if (clientSession.liveSession) {
    // VTID-01230: Deduplicated extraction on WebSocket disconnect
    const ls = clientSession.liveSession;
    if (ls.identity && ls.identity.tenant_id && ls.transcriptTurns.length > 0) {
      const fullTranscript = ls.transcriptTurns
        .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`)
        .join('\n');
      deduplicatedExtract({
        conversationText: fullTranscript,
        tenant_id: ls.identity.tenant_id,
        user_id: ls.identity.user_id,
        session_id: sessionId,
        force: true,
      });
      destroySessionBuffer(sessionId);
      clearExtractionState(sessionId);
    }

    clientSession.liveSession.active = false;

    // VTID-STREAM-KEEPALIVE: Clear upstream ping interval on cleanup
    if (clientSession.liveSession.upstreamPingInterval) {
      clearInterval(clientSession.liveSession.upstreamPingInterval);
      clientSession.liveSession.upstreamPingInterval = undefined;
    }
    if (clientSession.liveSession.silenceKeepaliveInterval) {
      clearInterval(clientSession.liveSession.silenceKeepaliveInterval);
      clientSession.liveSession.silenceKeepaliveInterval = undefined;
    }
    // VTID-WATCHDOG: Clear response watchdog on cleanup
    deps.clearResponseWatchdog(clientSession.liveSession);

    if (clientSession.liveSession.upstreamWs) {
      try {
        clientSession.liveSession.upstreamWs.close();
      } catch (e) {
        // Ignore
      }
    }

    liveSessions.delete(sessionId);
  }

  // Close client WebSocket if open
  if (clientSession.clientWs.readyState === WebSocketPkg.OPEN) {
    try {
      clientSession.clientWs.close(1000, 'Session cleanup');
    } catch (e) {
      // Ignore
    }
  }

  wsClientSessions.delete(sessionId);
  console.log(`[VTID-01222] WebSocket session cleaned up: ${sessionId}`);
}

// =============================================================================
// Session-action handlers
// =============================================================================

/**
 * `POST /api/v1/orb/live/stream/end-turn` — signal the Vertex Live API
 * that the user has finished speaking. Originally inline at
 * orb-live.ts:~12416.
 *
 * Behavior parity:
 *   - 400 when `session_id` is missing (from query OR body).
 *   - 404 when the session is not in `liveSessions`.
 *   - 400 when `session.active === false`.
 *   - VTID-ORBC ownership-mismatch warning (allowed through; UUIDs are
 *     unguessable).
 *   - VTID-01219: forwards `client_content.turn_complete:true` to upstream
 *     when the Vertex WS is OPEN.
 *   - Always 200 (success path message differs by whether Vertex was
 *     signaled or not).
 *
 * The other session-action handlers (`/live/session/start`,
 * `/live/session/stop`, `/live/stream/send`) follow in subsequent slices
 * using this same pattern.
 */
export async function handleLiveStreamEndTurn(
  req: AuthenticatedRequest,
  res: Response,
): Promise<Response> {
  const deps = getDeps();
  const { session_id } = req.query;
  const body = req.body as { session_id?: string };
  const effectiveSessionId = (session_id as string) || body.session_id;

  // VTID-ORBC: Resolve identity - JWT if present, DEV_IDENTITY in dev-sandbox, or anonymous.
  // Allow anonymous requests for lovable/external frontends.
  const identity = await deps.resolveOrbIdentity(req);

  if (!effectiveSessionId) {
    return res.status(400).json({ ok: false, error: 'session_id required' });
  }

  const session = liveSessions.get(effectiveSessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: 'Session not found' });
  }

  if (!session.active) {
    return res.status(400).json({ ok: false, error: 'Session not active' });
  }

  // VTID-ORBC: Log ownership mismatch but allow through — session IDs are UUIDs (unguessable).
  if (
    identity &&
    session.identity &&
    session.identity.user_id !== DEV_IDENTITY.USER_ID &&
    session.identity.user_id !== identity.user_id
  ) {
    console.warn(
      `[VTID-ORBC] /end-turn ownership mismatch (allowed): session_user=${session.identity.user_id}, request_user=${identity.user_id}, sessionId=${effectiveSessionId}`,
    );
  }

  // VTID-01219: Send end of turn to Live API
  if (session.upstreamWs && session.upstreamWs.readyState === WebSocketPkg.OPEN) {
    const sent = deps.sendEndOfTurn(session.upstreamWs);
    if (sent) {
      console.log(`[VTID-01219] End of turn sent to Live API: session=${effectiveSessionId}`);
      return res.status(200).json({ ok: true, message: 'End of turn signaled' });
    }
  }

  console.log(`[VTID-01219] End of turn (no Live API): session=${effectiveSessionId}`);
  return res.status(200).json({ ok: true, message: 'End of turn acknowledged (no Live API)' });
}

/**
 * `POST /api/v1/orb/live/session/start` — create a new Gemini Live session
 * for the ORB voice path. Originally inline at orb-live.ts:~11113.
 *
 * Behavior parity (lifted verbatim — see commit message for the exhaustive
 * VTID inventory):
 *   - 403 when origin fails `validateOrigin`.
 *   - 401 (`AUTH_TOKEN_INVALID`) when Bearer header present but `req.identity`
 *     is unset (VTID-AUTH-BACKEND-REJECT).
 *   - Builds clientContext, resolves identity, decides anonymous vs JWT.
 *   - Language priority: client-requested > stored > Accept-Language > 'en'.
 *   - Context bootstrap (Brain or legacy) kicked off in parallel for
 *     authenticated sessions, awaited later in connectToLiveAPI's ws.on(open).
 *   - VTID-SESSION-LIMIT: terminates any existing active sessions for user
 *     (except DEV_IDENTITY, which is shared across anonymous sessions).
 *   - VTID-02020: conversation_id pinning + resumedFromHistory flag.
 *   - VTID-02917: wake-timeline session_start_received event.
 *   - VTID-02918: wake-brief continuation decision (attached to response +
 *     session for observability; does NOT yet drive the spoken greeting).
 *   - OASIS event `vtid.live.session.start`.
 *   - 200 response with `{ ok, session_id, conversation_id, meta }`.
 */
/**
 * VTID-03079 (P0-3): build the Vertex wake-brief override block.
 *
 * The line below is rendered by the B0d-real composer (or the legacy
 * voice-wake-brief renderer). On Vertex, Gemini Live's model authors
 * the FIRST utterance from the system_instruction — so injecting this
 * block makes the picked line actually reach the user's ears. Because
 * the model speaks it as its own turn, the line is natively in
 * conversation context (no add_to_chat_ctx workaround needed).
 *
 * The block instructs the model to:
 *   1. Open with a warm 1-sentence greeting using the user's first
 *      name when available (return-aware tone, not generic
 *      "How can I help?").
 *   2. Then say the picked line VERBATIM — no paraphrasing.
 *
 * Trailing punctuation + quote escaping is handled inline so the
 * line can't accidentally close the prompt block.
 */
/** Sentinel marker — re-exported from wake-brief-marker.ts (extracted
 *  to break circular imports per VTID-03167). */
export { VERTEX_WAKE_BRIEF_OVERRIDE_MARKER } from '../instruction/wake-brief-marker';
import { VERTEX_WAKE_BRIEF_OVERRIDE_MARKER } from '../instruction/wake-brief-marker';

// VTID-03167: sentinel prefix that providers can use to ship a fully-
// formed structural block in `userFacingLine`. When present, the
// wake-brief override block IS the line content (already includes the
// VERTEX_WAKE_BRIEF_OVERRIDE_MARKER + its own structural directives).
// We do NOT wrap with the Say-exactly template in that case.
const STRUCTURED_BLOCK_PREFIX = '__VTID_03167_STRUCTURED_BLOCK__\n';

export function buildVertexWakeBriefBlock(
  line: string,
  _lang: string,
  dedupeKey: string | null,
): string {
  // VTID-03167: structured-block bypass. The provider already built a
  // complete block (with marker + structural directives). Use it as-is.
  if (line.startsWith(STRUCTURED_BLOCK_PREFIX)) {
    return line.slice(STRUCTURED_BLOCK_PREFIX.length);
  }
  // Escape backticks + close-quotes so a renderer-produced line with
  // quotes in it can't break the surrounding instruction block.
  const safe = line.replace(/`/g, "'").replace(/\r?\n/g, ' ').trim();
  const dedupeLine = dedupeKey ? `\nDedupe key: ${dedupeKey} (do NOT repeat after this turn).` : '';
  // VTID-03097: hard-instruction format. Earlier soft-instruction
  // ("Speak this VERBATIM") was being lost to the SHORT-GAP GREETING
  // PHRASES pool injection in live-system-instruction.ts:253. The
  // sentinel marker below is also detected by buildLiveSystemInstruction
  // to skip the pool injection entirely when an override is active.
  return `\n\n${VERTEX_WAKE_BRIEF_OVERRIDE_MARKER}

## SPOKEN FIRST UTTERANCE — REQUIRED VERBATIM (VTID-03079 / VTID-03097)

The user just opened the orb. Your FIRST spoken turn this session MUST
be EXACTLY this text. Copy these characters letter-for-letter; do not
paraphrase, do not translate, do not shorten, do not split into two
turns, do not append clarifying questions:

  "${safe}"

Rules:
  - Do NOT say "Wie kann ich dir helfen?" / "How can I help?" / "Was steht an?"
    / "Was liegt an?" / any standalone offer-to-help phrasing.
  - Do NOT pick a phrase from the "SHORT-GAP GREETING PHRASES" section —
    that section is SUPPRESSED for this turn.
  - Do NOT introduce yourself or list features.
  - The line above already contains both the greeting AND the proactive
    invitation. After speaking it, stop and wait for the user's reply.${dedupeLine}

This block OVERRIDES every other greeting rule in this prompt for the
first turn only. Subsequent turns follow the normal conversation flow.`;
}

export async function handleLiveSessionStart(
  req: AuthenticatedRequest,
  res: Response,
): Promise<Response> {
  const deps = getDeps();
  console.log('[VTID-ORBC] POST /orb/live/session/start');

  // Validate origin
  if (!deps.validateOrigin(req)) {
    return res.status(403).json({ ok: false, error: 'Origin not allowed' });
  }

  // VTID-AUTH-BACKEND-REJECT: If a Bearer token was provided but the JWT
  // failed verification, reject with 401 so the client knows to re-auth.
  // optionalAuth silently drops invalid tokens, which is fine for truly
  // anonymous widget requests on public pages (no Authorization header),
  // but lets stale authenticated sessions degrade into anonymous greetings —
  // which is how logged-in users ended up hearing the first-time intro
  // speech after their JWT expired in the background.
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ') && !req.identity) {
    console.warn('[VTID-AUTH-BACKEND-REJECT] Bearer token provided but JWT failed verification — returning 401');
    return res.status(401).json({
      ok: false,
      error: 'AUTH_TOKEN_INVALID',
      message: 'Session expired or invalid — please re-authenticate',
    });
  }

  // VTID-03107: Live AI voice quota gate (authenticated sessions only).
  // Anonymous sessions skip the gate (no user to bill). For authenticated
  // users we reserve quota up front; if exhausted with degrade behavior, we
  // allow the session to start but mark `voice_quota_exhausted` in the
  // response meta so the frontend can flip to Standard tier mode.
  //
  // Failures inside the guard never block a legitimate session — they log
  // and fall through to normal start. The cashflow guardrail is best-effort;
  // never trade availability for metering accuracy.
  const _earlyAuthHeader = req.headers.authorization;
  const _earlyAuthToken =
    _earlyAuthHeader && _earlyAuthHeader.startsWith('Bearer ')
      ? _earlyAuthHeader.slice(7)
      : undefined;
  let voiceQuotaReservation: Awaited<ReturnType<typeof reserveVoiceQuotaAtSessionStart>> | null = null;
  if (req.identity?.user_id && req.identity?.tenant_id) {
    try {
      voiceQuotaReservation = await reserveVoiceQuotaAtSessionStart(
        req.identity.user_id,
        req.identity.tenant_id,
        { authToken: _earlyAuthToken }
      );
    } catch (err: unknown) {
      console.warn(
        `[VTID-03107] voice quota reservation failed (failing open): ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (
      voiceQuotaReservation &&
      (voiceQuotaReservation.paywall_action === 'paywall' ||
        voiceQuotaReservation.paywall_action === 'hard_block')
    ) {
      // Quota exhausted AND the user's plan configures this feature as hard_block
      // (no PAYG path open at all). Record event + return 402 with paywall body.
      recordPaywallEvent(
        req.identity.user_id,
        req.identity.tenant_id,
        'voice_live_minutes',
        'shown',
        { context: 'session_start_blocked', vtid: 'VTID-03107' }
      ).catch(() => {});
      return res.status(402).json({
        ok: false,
        error: 'payment_required',
        paywall: {
          feature: 'voice_live_minutes',
          tier: 'unknown',
          quota: voiceQuotaReservation.quota,
          used: voiceQuotaReservation.used,
          remaining: voiceQuotaReservation.remaining,
          reset_at: voiceQuotaReservation.reset_at,
          credit_cost_per_unit: 0,
          user_credit_balance: 0,
          allowed_burn_buckets: ['purchased_credits'],
          credit_option: null,
          upgrade_url: '/api/v1/billing/checkout/subscription',
          paywall_action: voiceQuotaReservation.paywall_action,
        },
        vtid: 'VTID-03107',
      });
    }
  }

  const body = req.body as LiveSessionStartRequest;
  const clientRequestedLang = body.lang;
  console.log(`[LANG-PREF] Client requested lang: '${clientRequestedLang || 'NONE'}' (from POST body.lang)`);
  const voiceStyle = body.voice_style || 'friendly, calm, empathetic';
  const responseModalities = body.response_modalities || ['audio', 'text'];
  const conversationSummary = body.conversation_summary || undefined;
  const reconnectTranscriptHistory: Array<{ role: 'user' | 'assistant'; text: string }> =
    Array.isArray((body as any).transcript_history)
      ? ((body as any).transcript_history as any[])
          .filter((t: any) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string')
          .slice(-20)
      : [];
  const reconnectStage: 'idle' | 'listening_user_speaking' | 'thinking' | 'speaking' =
    typeof (body as any).reconnect_stage === 'string'
    && ((body as any).reconnect_stage === 'idle' || (body as any).reconnect_stage === 'listening_user_speaking'
        || (body as any).reconnect_stage === 'thinking' || (body as any).reconnect_stage === 'speaking')
      ? (body as any).reconnect_stage
      : 'idle';
  const incomingConversationId: string | null =
    typeof (body as any).conversation_id === 'string' && (body as any).conversation_id.length > 0
      ? (body as any).conversation_id : null;
  const isReconnectStart = reconnectTranscriptHistory.length > 0 || reconnectStage !== 'idle';
  const resolvedConversationId = incomingConversationId || randomUUID();
  if (isReconnectStart) {
    console.log(`[VTID-02020] Reconnect session start: stage=${reconnectStage}, history=${reconnectTranscriptHistory.length} turns, conversation_id=${resolvedConversationId} (incoming=${!!incomingConversationId})`);
  }

  // Generate session ID
  const sessionId = `live-${randomUUID()}`;

  // VTID-01224: Build bootstrap context pack (memory + knowledge) for system instruction
  let contextInstruction: string | undefined;
  let contextPack: ContextPack | undefined;
  let contextBootstrapLatencyMs: number | undefined;
  let contextBootstrapSkippedReason: string | undefined;

  // VTID-ANON: Anonymous = no verified JWT on the request.
  const hasJwtIdentity = !!(req.identity && req.identity.user_id);
  const isAnonymousSession = !hasJwtIdentity;

  // Resolve full identity (JWT verified → real user, or DEV_IDENTITY fallback)
  const orbIdentity = await deps.resolveOrbIdentity(req);
  const bootstrapIdentity: SupabaseIdentity | null = hasJwtIdentity ? orbIdentity : null;

  // VTID-CONTEXT: Build client context (IP geo, device, time) — for all sessions
  const clientContext = await deps.buildClientContext(req);
  console.log(`[VTID-ANON] Session ${sessionId}: hasJwtIdentity=${hasJwtIdentity}, isAnonymous=${isAnonymousSession}, req.identity.user_id=${req.identity?.user_id || 'none'}, orbIdentity.user_id=${orbIdentity?.user_id || 'none'}, bootstrapIdentity=${bootstrapIdentity ? bootstrapIdentity.user_id.substring(0, 8) : 'null'}`);
  console.log(`[VTID-CONTEXT] Client context: city=${clientContext.city || 'unknown'}, country=${clientContext.country || 'unknown'}, time=${clientContext.localTime || 'unknown'}, device=${clientContext.device || 'unknown'}, anonymous=${isAnonymousSession}`);

  // DEV-COMHU-0502 — ORB Recovery 1 (auth contract): structured identity
  // resolution telemetry. This is the OASIS signal that lets the Phase D
  // cockpit count "anonymous sessions on an authenticated surface" — the
  // metric that exposes the widget-side anonymous-drift bug from the outside.
  // Fire-and-forget: never block session start on telemetry.
  {
    const idResolvedRoute =
      typeof (body as any).current_route === 'string' ? (body as any).current_route : '';
    const idResolvedSurface = clientContext.isMobile
      ? 'vitanaland'
      : idResolvedRoute.startsWith('/command-hub')
        ? 'command-hub'
        : idResolvedRoute.startsWith('/admin')
          ? 'admin'
          : 'vitanaland';
    emitOasisEvent({
      vtid: 'DEV-COMHU-0502',
      type: 'orb.session.identity.resolved',
      source: 'orb-live',
      status: isAnonymousSession ? 'warning' : 'info',
      message: isAnonymousSession
        ? `session_start_anonymous (surface=${idResolvedSurface})`
        : `session_start_authenticated (surface=${idResolvedSurface})`,
      payload: {
        session_id: sessionId,
        surface: idResolvedSurface,
        has_authorization_header: !!req.headers.authorization,
        auth_valid: hasJwtIdentity,
        is_anonymous: isAnonymousSession,
        tenant_id: req.identity?.tenant_id ?? null,
        user_id: req.identity?.user_id ?? null,
        active_role: (req.identity as any)?.active_role ?? null,
        // Flag the drift case explicitly: an authenticated surface running anonymous.
        anonymous_on_authenticated_surface:
          isAnonymousSession && (idResolvedSurface === 'command-hub' || idResolvedSurface === 'admin'),
      },
      actor_id: req.identity?.user_id ?? undefined,
      surface: 'orb',
    }).catch(() => {});
  }

  // Resolve language priority:
  // 1. Client-requested lang
  // 2. Stored preference (parallel fetch)
  // 3. Accept-Language header
  // 4. 'en'
  let lang = deps.normalizeLang(clientRequestedLang || 'en');
  const needsStoredLang = !clientRequestedLang && bootstrapIdentity?.user_id && bootstrapIdentity?.tenant_id;
  const storedLangPromise: Promise<string | null> = needsStoredLang
    ? deps.getStoredLanguagePreference(bootstrapIdentity!.tenant_id!, bootstrapIdentity!.user_id)
    : Promise.resolve(null);
  if (clientRequestedLang) {
    console.log(`[LANG-PREF] Using client-requested language: ${lang} (user's UI selection)`);
  }
  if (isAnonymousSession && !clientRequestedLang && clientContext.lang) {
    const browserLang = deps.normalizeLang(clientContext.lang);
    if (browserLang !== 'en' || !clientRequestedLang) {
      lang = browserLang;
      console.log(`[LANG-PREF] Anonymous session using Accept-Language: ${lang}`);
    }
  }

  // VTID-01225-ROLE: Fetch real application role alongside context bootstrap
  let sseActiveRole: string | null = null;
  // VTID-01224-FIX: Last session info for context-aware greeting
  let lastSessionInfo: { time: string; wasFailure: boolean } | null = null;
  // BOOTSTRAP-ORB-CRITICAL-PATH: Promise resolving once context assembly has
  // populated the session fields below. Attached to the session object and
  // awaited by connectToLiveAPI's ws.on('open') handler.
  let contextReadyPromise: Promise<void> | undefined;

  // DEV-COMHU-0513 (new-day): FAST greeting-facts pre-fetch. Independent of the
  // heavy bootstrapWork above so the new-day personalized opener has a spoken
  // first name + last-session info ready at greeting time even under fast-start
  // (where the heavy block has NOT resolved yet). Populated only for authed,
  // non-anon, non-guided sessions AND only when FEATURE_ORB_SAFE_FAST_GREETING
  // is live. Resolved values are copied onto the session after it is created
  // (the session object is constructed further below). Fail-open: any error
  // leaves greetingFirstName null and the greeting builder falls through to the
  // existing generic opener.
  let greetingFirstName: string | null = null;
  let greetingEarlyLastSessionInfo: { time: string; wasFailure: boolean } | null = null;
  let greetingFactsReady: Promise<void> | undefined;

  // VTID-03294: a Guided-Journey topic tap needs ZERO context — Vitana just
  // picks up the KB lesson and speaks it. Detect it here so we can skip the
  // heavy Brain/memory/history/admin bootstrap (the 7-10s first-audio delay).
  const isGuidedTopicSession =
    typeof (body as any).guided_topic_id === 'string' && !!(body as any).guided_topic_id;

  if (isAnonymousSession) {
    contextBootstrapSkippedReason = 'anonymous_session';
    console.log(`[VTID-ANON] Anonymous session ${sessionId} — skipping memory, tools, lastSessionInfo. Context: city=${clientContext.city || 'unknown'}`);
  } else if (isGuidedTopicSession && bootstrapIdentity) {
    // VTID-03294: GUIDED FAST PATH. The lesson (spoken verbatim) + the GUIDE-MODE
    // (TEACH) block carry everything; the model only needs a short persona. We
    // skip the Brain context, memory, last-session, role lookup, admin briefing
    // and Autopilot offer entirely so first audio is ~real-time instead of
    // 7-10s. contextReadyPromise resolves in a microtask, so the setup-message
    // await in connectToLiveAPI is ~0ms.
    contextBootstrapSkippedReason = 'guided_topic_minimal';
    sseActiveRole = 'community';
    const isDe = (lang || 'en').toLowerCase().startsWith('de');
    const minimalGuidedContext = isDe
      ? 'Du bist Vitana — die warme, ruhige Stimme der Vitanaland-Langlebigkeits-Community. Du stellst gerade ein Thema aus der geführten Reise vor und erklärst es. Halte dich an die dir vorgegebene Lektion.'
      : 'You are Vitana — the warm, calm voice of the Vitanaland longevity community. You are introducing and teaching one Guided Journey topic. Stay on the lesson you are given.';
    contextReadyPromise = Promise.resolve().then(() => {
      session.active_role = 'community';
      session.lastSessionInfo = null;
      session.contextInstruction = minimalGuidedContext;
      session.contextPack = undefined;
      session.contextBootstrapLatencyMs = 0;
      session.contextBootstrapSkippedReason = 'guided_topic_minimal';
      session.contextBootstrapBuiltAt = Date.now();
    });
    console.log(`[VTID-03294] Guided-topic session ${sessionId}: minimal context (skipped heavy bootstrap) for fast first audio`);
  } else if (bootstrapIdentity) {
    const usingDevFallback = bootstrapIdentity.user_id === DEV_IDENTITY.USER_ID;
    console.log(`[VTID-01224] Building bootstrap context for SSE session ${sessionId} user=${bootstrapIdentity.user_id.substring(0, 8)}...${usingDevFallback ? ' (DEV_IDENTITY fallback)' : ''}`);

    const { isVitanaBrainOrbEnabled } = await import('../../../services/system-controls-service');
    const useOrbBrain = await isVitanaBrainOrbEnabled();
    const contextBuildStart = Date.now();

    const bootstrapWork = Promise.all([
      useOrbBrain
        ? (async () => {
            const brainStart = Date.now();
            try {
              const { buildBrainSystemInstructionCached } = await import('../../../services/vitana-brain-cache');
              const bodyRoute = typeof (body as any).current_route === 'string' ? (body as any).current_route : '';
              const brainRole = clientContext.isMobile
                ? 'community'
                : bodyRoute.startsWith('/command-hub')
                  ? 'developer'
                  : ((bootstrapIdentity as any).active_role || 'community');
              const { instruction, contextPack: cp } = await buildBrainSystemInstructionCached({
                user_id: bootstrapIdentity.user_id,
                tenant_id: bootstrapIdentity.tenant_id || 'default',
                role: brainRole,
                channel: 'orb',
                thread_id: sessionId,
                user_timezone: clientContext?.timezone,
              });
              console.log(`[VITANA-BRAIN] ORB context built in ${Date.now() - brainStart}ms (${instruction.length} chars)`);
              return { contextInstruction: instruction, contextPack: cp, latencyMs: Date.now() - brainStart };
            } catch (err: any) {
              console.warn(`[VITANA-BRAIN] ORB brain context failed, falling back to legacy: ${err.message}`);
              return deps.buildBootstrapContextPack(bootstrapIdentity, sessionId);
            }
          })()
        : deps.buildBootstrapContextPack(bootstrapIdentity, sessionId),
      usingDevFallback
        ? Promise.resolve(DEV_IDENTITY.ACTIVE_ROLE)
        : deps.resolveEffectiveRole(bootstrapIdentity.user_id, bootstrapIdentity.tenant_id || ''),
      deps.fetchLastSessionInfo(bootstrapIdentity.user_id),
      storedLangPromise,
      bootstrapIdentity.tenant_id
        ? fetchAdminBriefingBlock(bootstrapIdentity.tenant_id, 3).catch((err) => {
            console.warn(`[BOOTSTRAP-ADMIN-EE] SSE briefing fetch failed: ${err?.message}`);
            return null;
          })
        : Promise.resolve(null),
      // VTID-03201: proactive Autopilot offer. Fetched in parallel (no critical-path
      // cost) so Vitana can offer "you have things waiting in your Autopilot, want me
      // to run through them?" Only appended for community sessions (gated in .then).
      // Returns '' for users with an empty queue, so non-community users cost just one
      // empty query and no re-rank.
      import('../../../routes/autopilot-recommendations')
        .then((m) => m.buildAutopilotOfferBlock(bootstrapIdentity.user_id))
        .catch((err) => {
          console.warn(`[VTID-03201] SSE autopilot offer fetch failed: ${err?.message}`);
          return '';
        }),
    ]);

    contextReadyPromise = bootstrapWork
      .then(async ([bootstrapResult, fetchedSseRole, fetchedSessionInfo, storedLangResult, adminBriefing, autopilotOffer]) => {
        let resolvedRole = fetchedSseRole;
        const sseRoute = typeof (body as any).current_route === 'string' ? (body as any).current_route : '';
        if (sseRoute.startsWith('/command-hub') && (!resolvedRole || resolvedRole === 'community')) {
          console.log(`[VTID-01225-ROLE] Overriding role to "developer" for Command Hub session (was: ${resolvedRole || 'null'})`);
          resolvedRole = 'developer';
        }
        if (clientContext.isMobile && resolvedRole !== 'community') {
          console.log(`[BOOTSTRAP-ORB-MOBILE-ROLE] Forcing role to "community" for mobile session (was: ${resolvedRole || 'null'})`);
          resolvedRole = 'community';
        }

        let finalContext = bootstrapResult.contextInstruction || '';
        // VTID-03201: community sessions get the proactive Autopilot offer so
        // Vitana raises it unprompted. resolvedRole already folds mobile → community.
        if (resolvedRole === 'community' && autopilotOffer) {
          finalContext = finalContext ? `${finalContext}\n\n${autopilotOffer}` : autopilotOffer;
          console.log(`[VTID-03201] Autopilot proactive offer injected into SSE session ${sessionId} (${autopilotOffer.length} chars)`);
        }
        if (isAdminRole(resolvedRole) && adminBriefing) {
          finalContext = finalContext ? `${finalContext}\n\n${adminBriefing}` : adminBriefing;
          emitOasisEvent({
            vtid: 'BOOTSTRAP-ADMIN-EE',
            type: 'admin.briefing.injected',
            source: 'orb-live',
            status: 'info',
            message: `Admin briefing injected into SSE session ${sessionId}`,
            payload: { session_id: sessionId, tenant_id: bootstrapIdentity.tenant_id, role: resolvedRole, chars: adminBriefing.length },
            actor_id: bootstrapIdentity.user_id,
            actor_role: 'admin',
            surface: 'orb',
          }).catch(() => {});
        }

        if (bootstrapResult.skippedReason) {
          console.warn(`[VTID-01224] Context bootstrap skipped for ${sessionId}: ${bootstrapResult.skippedReason}`);
        } else {
          console.log(`[VTID-01224] Context bootstrap complete for ${sessionId}: ${bootstrapResult.latencyMs}ms, chars=${finalContext.length}`);
        }

        let finalLang = lang;
        if (storedLangResult && !clientRequestedLang) {
          finalLang = storedLangResult;
          console.log(`[LANG-PREF] No client lang — using stored preference: ${finalLang} for user=${bootstrapIdentity.user_id.substring(0, 8)}...`);
        }

        session.active_role = resolvedRole;
        session.lastSessionInfo = fetchedSessionInfo;
        session.contextInstruction = finalContext;
        session.contextPack = bootstrapResult.contextPack;
        session.contextBootstrapLatencyMs = bootstrapResult.latencyMs;
        session.contextBootstrapSkippedReason = bootstrapResult.skippedReason;
        session.contextBootstrapBuiltAt = Date.now();
        try {
          (session as any).onboardingCohortBlock = await deps.fetchOnboardingCohortBlock(bootstrapIdentity.user_id);
        } catch { /* non-blocking */ }
        if (finalLang !== session.lang) {
          session.lang = finalLang;
        }

        if (bootstrapIdentity.user_id && bootstrapIdentity.tenant_id) {
          deps.persistLanguagePreference(bootstrapIdentity.tenant_id, bootstrapIdentity.user_id, finalLang);
        }

        console.log(`[BOOTSTRAP-ORB-CRITICAL-PATH] Context ready for ${sessionId} in ${Date.now() - contextBuildStart}ms (role=${resolvedRole}, chars=${finalContext.length})`);
      })
      .catch((err) => {
        console.warn(`[BOOTSTRAP-ORB-CRITICAL-PATH] Context build rejected for ${sessionId}, proceeding with empty context:`, err?.message || err);
      });

    // DEV-COMHU-0513 (new-day): kick off a FAST, parallel pre-fetch of the two
    // facts the new-day personalized opener needs — the spoken first name and
    // the last-session timestamp — so they are ready at greeting time even when
    // the heavy bootstrapWork above has not resolved yet (fast-start). This runs
    // independently of bootstrapWork and never blocks session start. Gated on
    // the EXISTING FEATURE_ORB_SAFE_FAST_GREETING flag — a no-op when off, so
    // default behavior is 100% unchanged. Fail-open: every fetch failure leaves
    // greetingFirstName null (→ generic opener). The name-resolution mirrors the
    // canonical block (~memory_facts.user_name → app_users.display_name → email
    // via resolveSpokenFirstName); setting lastSessionInfo early is idempotent
    // with the heavy block, which sets the same field later.
    if (isFeatureLive('ORB_SAFE_FAST_GREETING')) {
      const _ndIdentity = bootstrapIdentity;
      greetingFactsReady = (async () => {
        try {
          const { getSupabase } = await import('../../../lib/supabase');
          const supa = getSupabase() ?? undefined;
          const [lastInfo, factResult, profileResult] = await Promise.allSettled([
            deps.fetchLastSessionInfo(_ndIdentity.user_id),
            supa
              ? supa
                  .from('memory_facts')
                  .select('fact_value')
                  .eq('user_id', _ndIdentity.user_id)
                  .eq('fact_key', 'user_name')
                  .maybeSingle()
              : Promise.resolve(null as any),
            supa
              ? supa
                  .from('app_users')
                  .select('display_name')
                  .eq('user_id', _ndIdentity.user_id)
                  .maybeSingle()
              : Promise.resolve(null as any),
          ]);

          if (lastInfo.status === 'fulfilled') {
            greetingEarlyLastSessionInfo = lastInfo.value;
          }

          const factValue =
            factResult.status === 'fulfilled' && factResult.value && !factResult.value.error
              ? (factResult.value.data as { fact_value?: string | null } | null)?.fact_value ?? null
              : null;
          const profileValue =
            profileResult.status === 'fulfilled' && profileResult.value && !profileResult.value.error
              ? (profileResult.value.data as { display_name?: string | null } | null)?.display_name ?? null
              : null;
          const resolved = resolveSpokenFirstName({
            memoryFactUserName: factValue,
            displayName: profileValue,
            email: _ndIdentity.email ?? null,
          });
          greetingFirstName = resolved.firstName;
          console.log(
            `[GREETING-FACTS-PREFETCH] session ${sessionId} resolved firstName=${greetingFirstName ? '<set>' : 'null'} lastSession=${greetingEarlyLastSessionInfo ? 'yes' : 'no'}`,
          );
        } catch (err: any) {
          // Fail-open to nulls — never reject.
          console.warn(`[GREETING-FACTS-PREFETCH] session ${sessionId} pre-fetch failed (non-fatal): ${err?.message || err}`);
        }
      })();
    }
  } else {
    contextBootstrapSkippedReason = 'no_identity';
    console.log(`[VTID-01224] Skipping context bootstrap for ${sessionId}: no identity`);
  }

  // Create session object
  const session: GeminiLiveSession = {
    sessionId,
    lang,
    voiceStyle,
    responseModalities,
    upstreamWs: null,
    sseResponse: null,
    active: true,
    createdAt: new Date(),
    lastActivity: new Date(),
    audioInChunks: 0,
    audioInForwarded: 0, // VTID-VOICE-FWD: only ++ when a chunk is actually sent upstream
    videoInFrames: 0,
    audioOutChunks: 0,
    turn_count: 0,
    contextInstruction,
    contextPack,
    contextBootstrapLatencyMs,
    contextBootstrapSkippedReason,
    contextBootstrapBuiltAt: Date.now(),
    contextReadyPromise,
    transcriptTurns: reconnectTranscriptHistory.length > 0
      ? reconnectTranscriptHistory.map((t) => ({ role: t.role, text: t.text, timestamp: new Date().toISOString() }))
      : [],
    outputTranscriptBuffer: '',
    pendingEventLinks: [],
    inputTranscriptBuffer: '',
    isModelSpeaking: false,
    turnCompleteAt: 0,
    identity: hasJwtIdentity ? orbIdentity || undefined : undefined,
    conversationSummary,
    active_role: sseActiveRole,
    lastAudioForwardedTime: Date.now(),
    lastTelemetryEmitTime: 0,
    vadSilenceMs: (body as any).vad_silence_ms && (body as any).vad_silence_ms >= 500 && (body as any).vad_silence_ms <= 3000
      ? (body as any).vad_silence_ms : getVadSilenceDurationMs(),
    greetingDeferred: false,
    lastSessionInfo,
    consecutiveModelTurns: 0,
    consecutiveToolCalls: 0,
    isAnonymous: isAnonymousSession,
    clientContext,
    current_route: typeof (body as any).current_route === 'string'
      ? (body as any).current_route
      : undefined,
    recent_routes: Array.isArray((body as any).recent_routes)
      ? ((body as any).recent_routes as any[])
          .filter((r): r is string => typeof r === 'string')
          .slice(0, 5)
      : undefined,
    is_mobile: typeof (body as any).is_mobile === 'boolean'
      ? (body as any).is_mobile
      : undefined,
    // VTID-03300: "My Journey" next-step focus. Set when the user opened the
    // orb by tapping a specific Foundation step; the journey-guide provider
    // leads with this step instead of the sequentially-computed next step.
    journey_focus_step: typeof (body as any).journey_focus_step === 'string'
      ? (body as any).journey_focus_step
      : undefined,
    // VTID-03290: Guided Journey catalog topic tapped. Set when the user opened
    // the orb by tapping a session/topic; the guided-topic-narration provider
    // leads turn-1 and teaches that topic from the published KB.
    guided_topic_id: typeof (body as any).guided_topic_id === 'string'
      ? (body as any).guided_topic_id
      : undefined,
  };

  // VTID-SESSION-LIMIT: Terminate any existing active sessions for this user.
  let terminatedCount = 0;
  const isDevIdentity = orbIdentity?.user_id === DEV_IDENTITY.USER_ID;
  if (orbIdentity?.user_id && !isDevIdentity) {
    terminatedCount = deps.terminateExistingSessionsForUser(orbIdentity.user_id, sessionId);
    if (terminatedCount > 0) {
      console.log(`[VTID-SESSION-LIMIT] Terminated ${terminatedCount} existing session(s) for user=${orbIdentity.user_id.substring(0, 8)}... before starting ${sessionId}`);
    }
  }

  // VTID-02020: pin the conversation_id + mark resumed-from-history
  session.conversation_id = resolvedConversationId;
  if (isReconnectStart) {
    (session as any).resumedFromHistory = true;
    (session as any).reconnectStage = reconnectStage;
  }

  // Store session
  liveSessions.set(sessionId, session);

  // DEV-COMHU-0513 (new-day): expose the fast greeting-facts pre-fetch on the
  // session so the greeting builder (sendGreetingPromptToLiveAPI) can do a
  // bounded wait for the spoken first name + last-session info under fast-start.
  // greetingFactsReady is undefined when FEATURE_ORB_SAFE_FAST_GREETING is off
  // (default → builder treats it as immediately ready and uses the generic
  // opener, i.e. behavior unchanged). When it resolves, copy the resolved facts
  // onto the session. Also seed from any value that already resolved.
  if (greetingFactsReady) {
    (session as any).greetingFirstName = greetingFirstName;
    if (greetingEarlyLastSessionInfo && !session.lastSessionInfo) {
      session.lastSessionInfo = greetingEarlyLastSessionInfo;
    }
    (session as any).greetingFactsReady = greetingFactsReady.then(() => {
      (session as any).greetingFirstName = greetingFirstName;
      // Idempotent with the heavy bootstrap block, which also sets this later.
      if (greetingEarlyLastSessionInfo && !session.lastSessionInfo) {
        session.lastSessionInfo = greetingEarlyLastSessionInfo;
      }
    });
  }

  // VTID-03107: arm the per-minute voice meter for authenticated sessions
  // whose quota gate is in 'allow' or 'degrade' state. 'deferred' sessions
  // do NOT advance the meter (D36 protection). Anonymous sessions skip
  // (no user to bill).
  if (
    voiceQuotaReservation &&
    req.identity?.user_id &&
    req.identity?.tenant_id &&
    voiceQuotaReservation.paywall_action !== 'deferred' &&
    voiceQuotaReservation.paywall_action !== 'hard_block' &&
    voiceQuotaReservation.paywall_action !== 'paywall'
  ) {
    const meterUserId = req.identity.user_id;
    const meterTenantId = req.identity.tenant_id;
    const startedRemaining = voiceQuotaReservation.remaining;
    let degradeAlreadyFired = voiceQuotaReservation.paywall_action === 'degrade';
    const timer = setInterval(async () => {
      const currentSession = liveSessions.get(sessionId);
      if (!currentSession || !currentSession.active) {
        // Session already ended; tear down ourselves as a belt-and-suspenders cleanup
        const handle = voiceMeterIntervals.get(sessionId);
        if (handle) {
          clearInterval(handle);
          voiceMeterIntervals.delete(sessionId);
        }
        return;
      }
      try {
        const newUsed = await recordVoiceMinute(meterUserId, meterTenantId, false);
        if (newUsed === null) return;
        // If we've now exceeded the start-of-session remaining, the user has
        // burned through their daily Live quota mid-call. Emit the dedicated
        // downgrade SSE event ONCE. The frontend's OrbDegradeBanner +
        // OrbTierBadge will flip on their own.
        const consumed = Math.max(0, newUsed - (voiceQuotaReservation!.used));
        if (!degradeAlreadyFired && consumed >= startedRemaining) {
          degradeAlreadyFired = true;
          const sseWriter = (_eventName: string, dataJson: string) => {
            const sseResponse = liveSessions.get(sessionId)?.sseResponse;
            if (sseResponse) {
              try {
                sseResponse.write(`data: ${dataJson}\n\n`);
              } catch {
                // SSE may have closed; non-blocking.
              }
            }
          };
          try {
            await triggerDowngrade(meterUserId, meterTenantId, sseWriter, 'session_quota');
          } catch (err) {
            console.warn(
              `[VTID-03107] triggerDowngrade failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      } catch (err) {
        console.warn(
          `[VTID-03107] voice-meter tick failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }, VOICE_METER_INTERVAL_MS);
    voiceMeterIntervals.set(sessionId, timer);
  }

  // VTID-02917 (B0d.3): wake-timeline session_start_received event
  try {
    defaultWakeTimelineRecorder.startSession({
      sessionId,
      tenantId: orbIdentity?.tenant_id ?? null,
      userId: orbIdentity?.user_id ?? null,
      surface: 'orb_wake',
      transport: 'sse',
    });
    defaultWakeTimelineRecorder.recordEvent({
      sessionId,
      name: 'session_start_received',
      metadata: {
        isReconnect: isReconnectStart,
        reconnectStage,
        lang: clientRequestedLang ?? null,
      },
    });
  } catch {
    // Best-effort; never block the wake path on telemetry.
  }

  // VTID-02918 (B0d.4): wake-brief continuation decision
  // VTID-03079 (P0-3): Vertex now passes `supabase` so the B0d-real
  // contextual_next_action provider can compete on this path (previously
  // it returned `skipped:no_next_action_inputs` and Vertex never spoke
  // a B0d-real next-action line). The picked `userFacingLine` is also
  // injected into `session.contextInstruction` below so the model
  // actually speaks it — before this fix it was computed, logged, and
  // dropped on the floor.
  // VTID-03081 (B1 wiring): the existing B1 cadence rules in
  // greeting-policy.ts (5-min cross-surface continuation, 15-min
  // greet-once cap, heavy-day dampening, same-style downgrade) were
  // never being enforced because nobody was feeding the cadence
  // signals into decideGreetingPolicy(). Now we read them from
  // user_assistant_state, pass them through, and record after fire.
  let wakeBriefDecision: Awaited<ReturnType<typeof decideWakeBriefForSession>> | null = null;

  // ORB-FAST-START Phase 2: the wake-brief continuation decision + journey
  // greeting block + turn-1 snapshot below are wrapped in this closure so they
  // can run inline (legacy) OR be composed into session.contextReadyPromise
  // (fast path). The body is byte-identical to the prior inline code — only
  // WHEN it runs changes. The stream-open gate (orb-live.ts ~6178) already
  // awaits session.contextReadyPromise before building the Gemini setup
  // message, so the first personalized turn keeps full wake-brief / Teacher /
  // Journey behavior either way. `wakeBriefDecision` stays declared in the
  // outer scope (above) so the response `meta` can still read it on the legacy
  // path; on the fast path it is null at response time (meta.context_status
  // reports 'pending') and is populated when this closure runs before the gate.
  // The closure RETURNS the decision so the legacy branch can assign it — that
  // lets TS control-flow analysis keep the union type at the meta read; the
  // fast branch ignores the return value.
  const assembleWakeBriefAndJourney = async (): Promise<
    Awaited<ReturnType<typeof decideWakeBriefForSession>> | null
  > => {
  // VTID-03085 (Lane 1): compile the AssistantDecisionContext on Vertex
  // so the 4 spine-dependent next-action sources can compete here too.
  // Before this fix Vertex passed `decisionContext: null` so:
  //   - life_compass_alignment            → skipped:no_decision_context
  //   - vitana_index_pillar               → skipped:no_decision_context
  //   - continuity_pending_thread         → skipped:no_decision_context
  //   - continuity_promise_owed           → skipped:no_decision_context
  // Only reminder / calendar / autopilot could fire on Vertex. LiveKit
  // already compiles the spine — this brings Vertex to parity.
  let decisionContextVertex: import('../../../orb/context/types').AssistantDecisionContext | null = null;
  if (orbIdentity?.tenant_id && orbIdentity?.user_id) {
    try {
      const { compileAssistantDecisionContext } = await import(
        '../../../orb/context/compile-assistant-decision-context'
      );
      decisionContextVertex = await compileAssistantDecisionContext({
        userId: orbIdentity.user_id,
        tenantId: orbIdentity.tenant_id,
      });
    } catch (exc) {
      // Fail-open: degraded behavior is "old Vertex" — never blocks session start.
      console.warn(
        `[VTID-03085] compileAssistantDecisionContext failed (non-fatal): ${(exc as Error).message}`,
      );
    }
  }
  (session as any).decisionContext = decisionContextVertex;

  // VTID-03210: hoisted out of the wake-brief try below so the single
  // turn-1 wake-decision snapshot (emitted after the journey-greeting
  // block) can read them outside that try's scope.
  let firstName: string | null = null;
  let firstNameSource: FirstNameSource = 'none';
  let wakeBucketForSnapshot: string | null = null;

  try {
    const temporal = deps.describeTimeSince(session.lastSessionInfo);
    wakeBucketForSnapshot = temporal.bucket;
    const { getSupabase } = await import('../../../lib/supabase');
    const supabaseClient = getSupabase() ?? undefined;
    const { fetchWakeCadenceSignals } = await import('../../../services/wake-cadence-signals');
    type CadenceSignals = Awaited<ReturnType<typeof fetchWakeCadenceSignals>>;
    let cadenceSignals: CadenceSignals = {};
    // VTID-03108 (Item 4): resolve the user's first name in parallel with
    // cadence so the Teacher's name-aware pool ("Willkommen zurück, Dragan.")
    // becomes available instead of falling back to the 5 no-name entries.
    // Source order mirrors orb-livekit.ts:1287-1289:
    //   1. memory_facts.user_name (the canonical fact the agent already
    //      maintains across sessions);
    //   2. app_users.display_name (provisioned at signup);
    //   3. JWT email local-part (deterministic last-resort so non-empty
    //      first names are common — most users register with their first
    //      name in the email handle, e.g. "dragan@..." → "dragan").
    // Best-effort: every fetch failure leaves firstName null, which sends
    // the Teacher to the no-name pool (still correct, just less personal).
    // VTID-03210: firstName + firstNameSource are declared in the outer
    // scope (above this try). firstNameSource tracks which source resolved
    // the name (memory_facts -> app_users -> email) so the documented
    // multi-source name-disagreement risk is observable in the snapshot.
    if (supabaseClient && orbIdentity?.tenant_id && orbIdentity?.user_id) {
      const [cadenceResult, factResult, profileResult] = await Promise.allSettled([
        fetchWakeCadenceSignals({
          supabase: supabaseClient,
          tenantId: orbIdentity.tenant_id,
          userId: orbIdentity.user_id,
        }),
        supabaseClient
          .from('memory_facts')
          .select('fact_value')
          .eq('user_id', orbIdentity.user_id)
          .eq('fact_key', 'user_name')
          .maybeSingle(),
        supabaseClient
          .from('app_users')
          .select('display_name')
          .eq('user_id', orbIdentity.user_id)
          .maybeSingle(),
      ]);
      if (cadenceResult.status === 'fulfilled') {
        cadenceSignals = cadenceResult.value;
      }
      // VTID-03248 (R1 slice 1): resolve the spoken first name through the
      // single canonical resolver. Behavior-identical to the previous inline
      // logic (memory_facts → app_users → email local-part), now shared so
      // LiveKit + every other call site resolve the SAME name with the SAME
      // precedence (the audit found this field diverging 3-4× per session).
      const factValue =
        factResult.status === 'fulfilled' && factResult.value && !factResult.value.error
          ? (factResult.value.data as { fact_value?: string | null } | null)?.fact_value ?? null
          : null;
      const profileValue =
        profileResult.status === 'fulfilled' && profileResult.value && !profileResult.value.error
          ? (profileResult.value.data as { display_name?: string | null } | null)?.display_name ?? null
          : null;
      const resolvedName = resolveSpokenFirstName({
        memoryFactUserName: factValue,
        displayName: profileValue,
        email: orbIdentity.email ?? null,
      });
      firstName = resolvedName.firstName;
      firstNameSource = resolvedName.source;
    }
    wakeBriefDecision = await decideWakeBriefForSession({
      sessionId,
      tenantId: orbIdentity?.tenant_id ?? null,
      userId: orbIdentity?.user_id ?? null,
      bucket: temporal.bucket,
      wasFailure: temporal.wasFailure,
      isReconnect: isReconnectStart,
      lang,
      // VTID-03300: forward the tapped "My Journey" step so journey-guide leads
      // with it. Undefined for normal opens → default next-step behaviour.
      journeyFocusStep: (session as any).journey_focus_step ?? null,
      // VTID-03290: forward the tapped Guided Journey topic so the
      // guided-topic-narration provider leads turn-1. Null for normal opens.
      guidedTopicId: (session as any).guided_topic_id ?? null,
      supabase: supabaseClient,
      // VTID-03085 (Lane 1): pass the compiled spine — unlocks
      // life_compass_alignment, vitana_index_pillar,
      // continuity_pending_thread, continuity_promise_owed on Vertex.
      decisionContext: decisionContextVertex,
      // Forward distilled pillar_momentum so the voice-wake-brief
      // renderer can fold in the slipping-pillar proactive variant on
      // Vertex (LiveKit already does this).
      pillarMomentum: decisionContextVertex?.pillar_momentum ?? null,
      cadenceSignals,
      // VTID-03108 (Item 4): firstName unlocks the Teacher's full 20-entry
      // name-aware greeting pool. LiveKit always passed this; Vertex never
      // did — that's why `firstname_len=0` showed on every Teacher pick.
      firstName,
      // VTID-03164: forward timezone from the client envelope so the
      // new-day-return provider can detect "first session of new calendar
      // day in user TZ". Missing → provider suppresses with reason
      // 'no_timezone' and falls through to wake-brief, same as before.
      timezone: session.clientContext?.timezone ?? null,
      // wake_origin is not yet plumbed from the client envelope on
      // Vertex; default 'unknown' so the B1 policy doesn't fire the
      // push_tap nudge. When the envelope ships this field through
      // /live/session/start body, swap to body.client_context.wakeOrigin.
      wakeOrigin: 'unknown',
      recordEmission: true,
    });
    (session as any).wakeBriefDecision = wakeBriefDecision;
    // VTID-03081: bump sessions_today_count fire-and-forget so the
    // next session can dampen if the user opens ORB 3+ times today.
    if (supabaseClient && orbIdentity?.tenant_id && orbIdentity?.user_id) {
      void (async () => {
        try {
          const { recordWakeSessionStart } = await import('../../../services/wake-cadence-signals');
          await recordWakeSessionStart({
            supabase: supabaseClient,
            tenantId: orbIdentity.tenant_id!,
            userId: orbIdentity.user_id,
            style: 'fresh_intro', // value-irrelevant; recordWakeSessionStart only writes the session counter
          });
        } catch {
          // ignore
        }
      })();
    }

    // VTID-03079: inject the picked userFacingLine as a system_instruction
    // override block so Gemini Live's model speaks it as the FIRST turn.
    // Because the model authors the line itself (the block tells it
    // "speak this exactly"), it's natively in conversation context —
    // no chat-ctx amnesia, no "I don't remember saying that" failure.
    const picked = wakeBriefDecision?.selectedContinuation ?? null;
    const line = picked?.userFacingLine?.trim();
    if (picked && line && line.length > 0 && !isReconnectStart) {
      const block = buildVertexWakeBriefBlock(line, lang, picked.dedupeKey ?? null);
      // VTID-03101: write to a DEDICATED session field instead of mutating
      // contextInstruction. The bootstrap promise above unconditionally
      // does `session.contextInstruction = finalContext` when it resolves
      // — and bootstrap typically finishes AFTER this synchronous block
      // (vitana-brain ~200-2000ms vs wake-brief ~50-200ms). Mutating
      // contextInstruction here meant the bootstrap overwrite always
      // wiped the override block, and the WS setup-message builder then
      // sent Gemini a prompt with NO override — so Gemini fell back to
      // its trained-default greeting ("Hello! How can I help today?")
      // and the Teacher line was never spoken. The setup-message builder
      // (orb-live.ts buildOrbVertexSetupEnvelope) now concatenates BOTH
      // contextInstruction AND wakeBriefOverrideBlock, eliminating the
      // race entirely.
      session.wakeBriefOverrideBlock = block;
      console.log(
        `[VTID-03079/VTID-03101] Vertex wake-brief stored on session.wakeBriefOverrideBlock (decision_id=${wakeBriefDecision?.decisionId}, source=${picked.evidence?.find((e) => e.kind?.startsWith('source:'))?.kind || 'voice_wake_brief'}, block_chars=${block.length})`,
      );

      // VTID-03218 (R3): Teacher Mode content is now bundled ATOMICALLY on
      // the winning candidate by the provider (no separate post-win fetch).
      // If the provider couldn't resolve content it returned 'errored' and
      // never won the ranker — so a Teacher winner here ALWAYS carries
      // content. This closes the VTID-03112 bug where the permission-asking
      // opener fired with teacherModeContent=null and Gemini closed the
      // overlay the moment the user said yes (no turn-2+ instructions).
      const bundledTeacherMode = (picked as {
        teacherMode?:
          | import('../../teacher/teacher-content-resolver').TeacherModeContent
          | null;
      }).teacherMode ?? null;
      if (bundledTeacherMode) {
        (session as any).teacherModeContent = bundledTeacherMode;
        (session as any).teacherModeFirstName = firstName;
        console.log(
          `[VTID-03218] Teacher Mode content (bundled on candidate) for ${sessionId}: capability=${bundledTeacherMode.active_capability_key} manual_chars=${bundledTeacherMode.active_manual_content.length} remaining=${bundledTeacherMode.remaining_capabilities.length}`,
        );
      }

      // VTID-03257 (Fix-1): when the journey-guide won, bundle its GUIDE-MODE
      // content onto the session so the envelope injects the lead-the-journey
      // block (proactive, one-step, do-it-together, verify-on-claim, never
      // "what do you want"). Mirrors the Teacher bundling above.
      const bundledJourneyGuide = (picked as {
        journeyGuide?:
          | import('../../../services/assistant-continuation/providers/journey-guide').JourneyGuideContent
          | null;
      }).journeyGuide ?? null;
      if (bundledJourneyGuide) {
        (session as any).journeyGuideContent = bundledJourneyGuide;
        console.log(
          `[VTID-03257] Journey guide leading for ${sessionId}: step=${bundledJourneyGuide.step_key} (${bundledJourneyGuide.step_type}) title="${bundledJourneyGuide.step_title}"`,
        );
      }

      // VTID-03290: when guided-topic-narration won (a catalog topic was tapped),
      // bundle its TEACH content onto the session so the envelope injects the
      // teach-this-topic-from-the-KB block. Mirrors the journey-guide bundling.
      const bundledGuidedTopic = (picked as {
        guidedTopicNarration?:
          | import('../../../services/assistant-continuation/providers/guided-topic-narration').GuidedTopicNarrationContent
          | null;
      }).guidedTopicNarration ?? null;
      if (bundledGuidedTopic) {
        (session as any).guidedTopicNarrationContent = bundledGuidedTopic;
        console.log(
          `[VTID-03290] Guided topic narration leading for ${sessionId}: topic=${bundledGuidedTopic.topic_id} title="${bundledGuidedTopic.topic_title}" source=${bundledGuidedTopic.source}`,
        );
      }
    }
  } catch (e) {
    console.warn(
      `[VTID-02918] wake-brief decision failed for ${sessionId}: ${(e as Error).message}`,
    );
  }

  // VTID-03154 Slices C + D: journey-greeting block.
  // Resolves the persistent user_journey row (Slice A) and decides whether
  // this session should open with the one-time first-session welcome
  // (is_first_session=true) or the daily-morning greeting (new calendar
  // day in user TZ). Anonymous and missing-user sessions are skipped.
  // Best-effort: any failure leaves journeyGreetingBlock empty and the
  // session falls back to today's behavior. Self-contained scope — uses
  // its own supabase handle so wake-brief failures upstream don't
  // suppress the journey greeting.
  try {
    if (orbIdentity?.user_id) {
      const { getSupabase: getSupa } = await import('../../../lib/supabase');
      const supa = getSupa();
      if (supa) {
        const [
          { getJourneyState, updateSessionEndState },
          { buildJourneyGreetingBlock, todayInTimezone },
          { fetchLifeCompass },
        ] = await Promise.all([
          import('../../../services/journey/user-journey-service'),
          import('../instruction/journey-greeting'),
          import('../../../services/user-context-profiler'),
        ]);
        const journey = await getJourneyState(supa, orbIdentity.user_id);
        if (journey) {
          const lifeCompass = await fetchLifeCompass(supa, orbIdentity.user_id).catch(() => null);
          const tz = (session as any).clientContext?.timezone ?? null;
          const todayDateIso = todayInTimezone(new Date(), tz);
          // Best-effort first-name read for the contract. The wake-brief
          // resolves firstName upstream; we read app_users.display_name
          // here as a self-contained fallback so this block does not
          // depend on the wake-brief try-block scope.
          let nameForGreeting: string | null = null;
          try {
            const { data: prof } = await supa
              .from('app_users')
              .select('display_name')
              .eq('user_id', orbIdentity.user_id)
              .maybeSingle();
            const dn = (prof?.display_name as string | undefined) ?? null;
            if (dn) nameForGreeting = dn.split(/\s+/)[0] || null;
          } catch { /* leave nameForGreeting null */ }
          // VTID-03255 — the one guided next move, so the morning greeting
          // drives the journey. Best-effort: never block the greeting on it.
          let journeyNextMove: { title: string; benefit: string } | null = null;
          try {
            const jfSnap = await buildJourneyFoundationSnapshot(supa, orbIdentity.user_id);
            if (jfSnap.current_next_step) {
              journeyNextMove = {
                title: jfSnap.current_next_step.title,
                benefit: jfSnap.current_next_step.benefit,
              };
            }
          } catch { /* leave journeyNextMove null */ }
          const result = buildJourneyGreetingBlock({
            journey,
            lifeCompassGoalText: lifeCompass?.primary_goal ?? null,
            firstName: nameForGreeting,
            lang,
            todayDateIso,
            nextMove: journeyNextMove,
          });
          if (result.block && result.meta) {
            (session as any).journeyGreetingBlock = result.block;
            (session as any).journeyGreetingMeta = result.meta;
            // VTID-03160 REVERT: VTID-03154 cleared wakeBriefOverrideBlock
            // and VTID-03157 cleared teacherModeContent so the journey
            // greeting could own turn 1. Both clearings broke the Teacher
            // flow in production: with teacherModeContent null, the
            // Teacher's permission-asking opener still fired (via the
            // wake-brief Say-exactly OR via Gemini's general prompt
            // memory) but there were no turn-2+ instructions to guide
            // what to teach, so Gemini fell back to the
            // end_teaching_session tool and closed the overlay the
            // moment the user said yes.
            //
            // Restoring the working Teacher experience is more important
            // than the journey-greeting framing right now. The greeting
            // block is still set on the session (orb-live.ts appends it
            // into the system instruction), so the LLM sees the
            // journey-day context, but it does NOT pre-empt the existing
            // wake-brief or Teacher Mode pathways. Proper journey-vs-
            // Teacher integration is a follow-up slice that requires
            // either (a) reordering the concat so journeyGreetingBlock
            // gets recency primacy AND adding journey-aware preamble to
            // the Teacher Mode block so it cedes turn 1 cleanly, or (b)
            // suppressing the wake-brief's Teacher-winner selection
            // upstream when journey-greeting will fire.
            // TODO(R1 slice): migrate the plan_phase + life_compass-state
            // derivation onto resolveJourneyPlanPhase / resolveLifeCompassState
            // (services/awareness-unified-context.ts). NOT done here because it
            // is NOT a no-op: the live derivation in new-day-overview-payload.ts
            // is 3-way (it folds a past target_date into on_personalized_goal +
            // a separate days_past_deadline), whereas the canonical resolver is
            // the §1.4 4-way that promotes a past target_date to 'goal_completed'.
            // The 'set'/'unset' below is also object-presence, not the canonical
            // primary_goal/set_at rule. Migrating either changes behavior, so it
            // waits for the R7 goal-completion provider that consumes the 4th phase.
            console.log(
              `[VTID-03154] Journey greeting prepared for ${sessionId}: kind=${result.meta.kind} day=${journey.day_in_journey}/${journey.total_days} phase=${journey.current_wave?.id ?? 'none'} life_compass=${lifeCompass ? 'set' : 'unset'}`,
            );
            // Fire-and-forget update: clear is_first_session for Slice C,
            // advance last_session_date for both kinds so same-day repeat
            // sessions don't re-fire the morning greeting.
            const userIdForUpdate = orbIdentity.user_id;
            updateSessionEndState(supa, userIdForUpdate, {
              last_session_date: result.meta.today_date_iso,
              clear_first_session: result.meta.kind === 'first_session',
            }).catch((err: any) =>
              console.warn(`[VTID-03154] update after fire failed (non-fatal): ${err.message}`),
            );
          }
        }
      }
    }
  } catch (e) {
    console.warn(
      `[VTID-03154] journey-greeting resolution failed (non-fatal) for ${sessionId}: ${(e as Error).message}`,
    );
  }

  // VTID-03210: emit ONE structured turn-1 wake-decision snapshot. Runs
  // after both the wake-brief and journey-greeting blocks are resolved so
  // turn1_collision can see all three turn-1 blocks at once. Observability
  // only — never throws, mutates nothing.
  logWakeDecisionSnapshot({
    transport: 'vertex',
    sessionId,
    decision: wakeBriefDecision,
    blocks: {
      wakeBriefOverride: !!session.wakeBriefOverrideBlock,
      teacherModeContent: !!(session as any).teacherModeContent,
      journeyGreeting: !!(session as any).journeyGreetingBlock,
    },
    firstName: { value: firstName, source: firstNameSource },
    lang,
    bucket: wakeBucketForSnapshot,
    isReconnect: isReconnectStart,
    timezonePresent: !!session.clientContext?.timezone,
  });

  return wakeBriefDecision;
  }; // end assembleWakeBriefAndJourney

  // ORB-FAST-START Phase 2: run the wake-brief + journey work inline (legacy)
  // or defer it onto the stream-open gate's promise (fast). Flag-gated; default
  // off. Anonymous + guided-topic sessions always run inline (they skip or
  // already fast-path this work).
  const fastStartDeferWake = shouldDeferWakeWork({
    isAnonymousSession,
    isGuidedTopicSession,
    hasUserId: !!orbIdentity?.user_id,
  });
  if (fastStartDeferWake) {
    // Compose onto the SAME promise the stream-open gate already awaits, so
    // first personalized audio still carries the full continuation / Teacher /
    // Journey blocks — but session/start returns now instead of after the
    // wake-brief + journey round-trips.
    const brainReady = (session as any).contextReadyPromise as Promise<void> | undefined;
    // DEV-COMHU-0513 B2: mark context as not-yet-resolved while the deferred
    // wake-brief/journey work runs, so the greeting builder can detect "context
    // still pending" and (under FEATURE_ORB_SAFE_FAST_GREETING) emit a short,
    // audio-safe opener instead of a temporal-misclassified long intro that
    // makes Gemini Live go text-only. Only the fast-start (deferred) path starts
    // false; legacy/inline sessions never set it, so they read as resolved.
    (session as any).contextReadyResolved = false;
    const composedContextReady = composeContextReady(
      brainReady,
      assembleWakeBriefAndJourney,
    );
    (session as any).contextReadyPromise = composedContextReady;
    void composedContextReady.finally(() => {
      (session as any).contextReadyResolved = true;
    });
    console.log(
      `[ORB-FAST-START] session ${sessionId}: wake-brief + journey deferred onto contextReadyPromise (fast session/start)`,
    );
  } else if (!isAnonymousSession) {
    // Legacy inline path: assign the return value so TS control-flow analysis
    // sees wakeBriefDecision populated for the response meta below.
    wakeBriefDecision = await assembleWakeBriefAndJourney();
  }
  // ANON-WAKE-SKIP: anonymous (pre-login) sessions deliberately do NOT run the
  // authenticated wake-brief / journey / decision-context pipeline. Its result
  // is discarded for anonymous sessions anyway — every greeting-builder branch
  // that consumes wakeBriefDecision is gated behind `!session.isAnonymous`
  // (orb-live.ts: wake-override speak, cadence-silence, context-pending), and the
  // pre-login intro speech is driven by buildAnonymousSystemInstruction's own
  // verbatim-speech path. Running it inline only piled Supabase round-trips +
  // emission writes onto the pre-login critical path (session/start observed at
  // ~4.5s), pushing slow/mobile clients past the orb-widget's 8s session-start
  // timeout — so the orb opened, flipped to "listening", and never received the
  // greeting (the "pre-login speech doesn't start / doesn't react to input"
  // report). The fast-start path already defers this work for authenticated
  // users (shouldDeferWakeWork), which is why post-login was unaffected.
  // wakeBriefDecision stays null → response meta reports wake_brief:null, which
  // the widget does not depend on for anonymous sessions.

  // Emit OASIS event with identity context.
  // ORB-FAST-START Phase 1a: fire-and-forget. session.start IS a real state
  // transition (so we still emit it), but blocking the HTTP response on the
  // Supabase write put a telemetry round-trip on the wake critical path —
  // telemetry must never block the wake path. The event still fires; the
  // user's response no longer waits for it. Errors are swallowed into the
  // emitter's own logging (it already logs internally).
  deps.emitLiveSessionEvent('vtid.live.session.start', {
    session_id: sessionId,
    user_id: orbIdentity?.user_id || 'anonymous',
    tenant_id: orbIdentity?.tenant_id || null,
    email: orbIdentity?.email || null,
    active_role: sseActiveRole || null,
    user_agent: req.headers['user-agent'] || null,
    origin: req.headers['origin'] || req.headers['referer'] || null,
    transport: 'sse',
    lang,
    modalities: responseModalities,
    voice: deps.getVoiceForLang(lang),
  }).catch((err) => {
    console.warn(
      `[ORB-FAST-START] emitLiveSessionEvent failed (non-blocking) for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  console.log(`[VTID-ORBC] Live session created: ${sessionId} (user=${orbIdentity?.user_id || 'anonymous'}, tenant=${orbIdentity?.tenant_id || 'none'}, lang=${lang}, contextDeferred=${!!contextReadyPromise})`);

  // BOOTSTRAP-VOICE-DEMO: real heartbeat
  recordAgentHeartbeat('orb-live').catch(() => {});

  return res.status(200).json({
    ok: true,
    session_id: sessionId,
    conversation_id: resolvedConversationId,
    meta: {
      lang,
      voice: deps.getVoiceForLang(lang),
      modalities: responseModalities,
      model: VERTEX_LIVE_MODEL,
      // VTID-03107: voice quota snapshot at session start. Frontend reads
      // this to know whether to display the Standard-tier badge from the
      // get-go (start_on_standard_tier=true) and how much quota remains.
      voice_quota: voiceQuotaReservation
        ? {
            tier: voiceQuotaReservation.start_on_standard_tier ? 'standard' : 'live',
            quota: voiceQuotaReservation.quota,
            used: voiceQuotaReservation.used,
            remaining: voiceQuotaReservation.remaining,
            reset_at: voiceQuotaReservation.reset_at,
            deferred_for_vulnerability: voiceQuotaReservation.deferred_for_vulnerability,
            paywall_action: voiceQuotaReservation.paywall_action,
          }
        : null,
      context_bootstrap: {
        latency_ms: contextBootstrapLatencyMs ?? null,
        context_chars: null,
        skipped_reason: contextBootstrapSkippedReason || null,
        deferred: !!contextReadyPromise,
      },
      // ORB-FAST-START Phase 2: 'pending' when wake-brief + journey were
      // deferred onto contextReadyPromise (fast path) — they attach before the
      // first personalized turn. 'ready' on the legacy inline path. The widget
      // must NOT depend on meta.wake_brief being populated when this is
      // 'pending'.
      context_status: fastStartDeferWake ? 'pending' : 'ready',
      wake_brief: wakeBriefDecision
        ? {
            decision_id: wakeBriefDecision.decisionId,
            selected_kind:
              wakeBriefDecision.selectedContinuation?.kind ?? 'none_with_reason',
            user_facing_line:
              wakeBriefDecision.selectedContinuation?.userFacingLine ?? '',
            suppression_reason:
              wakeBriefDecision.selectedContinuation?.kind === 'none_with_reason'
                ? wakeBriefDecision.selectedContinuation.suppressReason
                : wakeBriefDecision.suppressionReason ?? null,
          }
        : null,
    },
  });
}

/**
 * `POST /api/v1/orb/live/session/stop` — close the Gemini Live session and
 * trigger session-end side effects. Originally inline at orb-live.ts:~11153.
 *
 * Behavior parity (lifted verbatim):
 *   - 400 when `session_id` missing.
 *   - 404 when session not found in `liveSessions`.
 *   - VTID-ORBC ownership-mismatch warning (allowed through).
 *   - Closes upstream WS + writes `{type:'session_ended'}` to SSE + ends SSE.
 *   - Marks `session.active=false`.
 *   - VTID-STREAM-KEEPALIVE: clears upstream ping + silence keepalive intervals.
 *   - VTID-WATCHDOG: clears response watchdog.
 *   - OASIS event `vtid.live.session.stop` (with VTID-NAV-TIMEJOURNEY user_id).
 *   - VTID-01959/VTID-01994: voice self-healing dispatch with session metrics.
 *   - VTID-01225: fire-and-forget Cognee extraction (transcriptTurns first,
 *     memory_items fallback). VTID-01230 dedup pass on the same transcript.
 *   - VTID-01230: destroySessionBuffer + clearExtractionState.
 *   - Removes from `liveSessions`.
 *   - VTID-02917: wake-timeline disconnect event + endSession.
 *   - 200 `{ ok: true }`.
 */
export async function handleLiveSessionStop(
  req: AuthenticatedRequest,
  res: Response,
): Promise<Response> {
  const deps = getDeps();
  console.log('[VTID-ORBC] POST /orb/live/session/stop');

  const { session_id } = req.body;
  const orbIdentity = await deps.resolveOrbIdentity(req);

  if (!session_id) {
    return res.status(400).json({ ok: false, error: 'session_id required' });
  }

  const session = liveSessions.get(session_id);
  if (!session) {
    return res.status(404).json({ ok: false, error: 'Session not found' });
  }

  // VTID-ORBC: Log ownership mismatch but allow through — session IDs are UUIDs (unguessable).
  if (
    session.identity &&
    orbIdentity &&
    orbIdentity.user_id !== DEV_IDENTITY.USER_ID &&
    session.identity.user_id !== orbIdentity.user_id
  ) {
    console.warn(
      `[VTID-ORBC] /session/stop ownership mismatch (allowed): session_user=${session.identity.user_id}, request_user=${orbIdentity.user_id}, sessionId=${session_id}`,
    );
  }

  // Close upstream WebSocket if exists
  if (session.upstreamWs) {
    try {
      session.upstreamWs.close();
    } catch (e) {
      // Ignore close errors
    }
    session.upstreamWs = null;
  }

  // Close SSE response if exists
  if (session.sseResponse) {
    try {
      session.sseResponse.write(`data: ${JSON.stringify({ type: 'session_ended' })}\n\n`);
      session.sseResponse.end();
    } catch (e) {
      // Ignore
    }
    session.sseResponse = null;
  }

  session.active = false;

  // VTID-03107: tear down the per-minute voice meter
  const voiceMeterHandle = voiceMeterIntervals.get(session_id);
  if (voiceMeterHandle) {
    clearInterval(voiceMeterHandle);
    voiceMeterIntervals.delete(session_id);
  }

  // VTID-STREAM-KEEPALIVE: Clear upstream ping interval on session stop
  if (session.upstreamPingInterval) {
    clearInterval(session.upstreamPingInterval);
    session.upstreamPingInterval = undefined;
  }
  if (session.silenceKeepaliveInterval) {
    clearInterval(session.silenceKeepaliveInterval);
    session.silenceKeepaliveInterval = undefined;
  }
  // VTID-WATCHDOG: Clear response watchdog on session stop
  deps.clearResponseWatchdog(session);

  // Emit OASIS event
  // VTID-NAV-TIMEJOURNEY: include user_id so fetchLastSessionInfo can find
  // this event when the user next opens the ORB.
  await deps.emitLiveSessionEvent('vtid.live.session.stop', {
    session_id,
    user_id: session.identity?.user_id || null,
    tenant_id: session.identity?.tenant_id || null,
    audio_in_chunks: session.audioInChunks,
    audio_in_forwarded_chunks: session.audioInForwarded, // VTID-VOICE-FWD (Track A)
    video_in_frames: session.videoInFrames,
    audio_out_chunks: session.audioOutChunks,
    duration_ms: Date.now() - session.createdAt.getTime(),
    turn_count: session.turn_count,
    user_turns: session.transcriptTurns.filter((t) => t.role === 'user').length,
    model_turns: session.transcriptTurns.filter((t) => t.role === 'assistant').length,
  });

  // VTID-03255: write a Journey Foundation session summary (fire-and-forget).
  // Feeds the "since we last spoke" line + morning greeting on next open. Never
  // allowed to affect teardown — failures are swallowed inside the writer.
  if (session.identity?.user_id) {
    const jfUrl = process.env.SUPABASE_URL;
    const jfKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
    if (jfUrl && jfKey) {
      const jfClient = createJourneySupabaseClient(jfUrl, jfKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      void recordJourneySessionSummary(jfClient, session.identity.user_id, session_id);
    }
  }

  // VTID-01959: voice self-healing dispatch (mode-gated for /report path).
  // VTID-01994: pass session metrics for mode-independent quality classifier.
  dispatchVoiceFailureFireAndForget({
    sessionId: session_id,
    tenantScope: session.identity?.tenant_id || 'global',
    metadata: { synthetic: (session as any).synthetic === true },
    sessionMetrics: {
      audio_in_chunks: session.audioInChunks,
      audio_in_forwarded: session.audioInForwarded, // VTID-VOICE-FWD (Track A)
      audio_out_chunks: session.audioOutChunks,
      duration_ms: Date.now() - session.createdAt.getTime(),
      turn_count: session.turn_count,
      user_turns: session.transcriptTurns.filter((t) => t.role === 'user').length,
      model_turns: session.transcriptTurns.filter((t) => t.role === 'assistant').length,
    },
  });

  // VTID-01225: Fire-and-forget entity extraction from live session.
  // Use in-memory transcriptTurns (UNFILTERED full conversation) instead of memory_items.
  // Falls back to memory_items query only if transcriptTurns is empty.
  if (session.identity && session.identity.tenant_id) {
    const tenantId = session.identity.tenant_id;
    const userId = session.identity.user_id;

    if (session.transcriptTurns.length > 0) {
      const fullTranscript = session.transcriptTurns
        .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}`)
        .join('\n');

      if (fullTranscript.length > 50) {
        if (cogneeExtractorClient.isEnabled()) {
          cogneeExtractorClient.extractAsync({
            transcript: fullTranscript,
            tenant_id: tenantId,
            user_id: userId,
            session_id,
            active_role: session.active_role || 'community',
          });
          console.log(`[VTID-01225] Cognee extraction queued from transcriptTurns (${session.transcriptTurns.length} turns): ${session_id}`);
        }

        // VTID-01230: Deduplicated extraction (force on session end)
        deduplicatedExtract({
          conversationText: fullTranscript,
          tenant_id: tenantId,
          user_id: userId,
          session_id,
          force: true,
        });
      }
    } else {
      // Fallback: query memory_items if no in-memory transcript available
      fetchRecentConversationForCognee(tenantId, userId, session.createdAt, new Date())
        .then((transcript) => {
          if (transcript && transcript.length > 50) {
            if (cogneeExtractorClient.isEnabled()) {
              cogneeExtractorClient.extractAsync({
                transcript,
                tenant_id: tenantId,
                user_id: userId,
                session_id,
                active_role: session.active_role || 'community',
              });
              console.log(`[VTID-01225] Cognee extraction queued from memory_items fallback: ${session_id}`);
            }

            // VTID-01230: Deduplicated extraction from memory_items fallback
            deduplicatedExtract({
              conversationText: transcript,
              tenant_id: tenantId,
              user_id: userId,
              session_id,
              force: true,
            });
          } else {
            console.log(`[VTID-01225] No meaningful transcript for extraction: ${session_id}`);
          }
        })
        .catch((err) => {
          console.error(`[VTID-01225] Failed to fetch conversation for extraction: ${err.message}`);
        });
    }
  }
  // VTID-01226: Removed fallback for unauthenticated sessions - auth is now required

  // VTID-01230: Clean up session buffer and extraction state on session stop
  destroySessionBuffer(session_id);
  clearExtractionState(session_id);

  // Remove from store
  liveSessions.delete(session_id);

  // VTID-02917 (B0d.3): record disconnect + flush the wake timeline.
  // Best-effort: never block the stop path.
  try {
    defaultWakeTimelineRecorder.recordEvent({
      sessionId: session_id,
      name: 'disconnect',
      metadata: {
        disconnect_reason: 'session_stop_requested',
        transport: 'sse',
      },
    });
    void defaultWakeTimelineRecorder.endSession(session_id).catch(() => {
      // swallow — debugging tool must not break the stop path.
    });
  } catch {
    // ignore
  }

  console.log(`[VTID-01155] Live session stopped: ${session_id}`);

  return res.status(200).json({ ok: true });
}

/**
 * `POST /api/v1/orb/live/stream/send` — receive audio / video / text /
 * interrupt frames from the ORB client and forward to the upstream Vertex
 * Live WS. Originally inline at orb-live.ts:~11693.
 *
 * Behavior parity (lifted verbatim — see commit for the exhaustive VTID list):
 *   - 400 missing session_id, 404 session not found, 400 session not active.
 *   - VTID-ANON-NUDGE: silently drops audio/text after turn limit on
 *     anonymous sessions or once signupIntentDetected fires.
 *   - VTID-NAV: drops audio while a navigation is queued.
 *   - VTID-VOICE-INIT: echo prevention gate (drops mic audio while model
 *     speaks).
 *   - VTID-ECHO-COOLDOWN: post-turn cooldown drops audio for
 *     POST_TURN_COOLDOWN_MS after turn_complete.
 *   - VTID-01219: forwards audio chunks via `sendAudioToLiveAPI`.
 *   - VTID-FORWARDING-WATCHDOG / VTID-01984: sliding watchdog when Vertex
 *     hasn't shown life yet.
 *   - 10s telemetry batching for audio.in.chunk + video.in.frame.
 *   - VTID-VOICE-INIT text: forwards text turns as client_content
 *     turn_complete=true.
 *   - VTID-VOICE-INIT interrupt: ungates mic + sendEndOfTurn + clears
 *     output buffer + emits SSE `{type:'interrupted'}`.
 *   - 500 on uncaught error.
 *   - 200 `{ ok: true }` (or `{ ok:true, dropped:true, reason:... }` /
 *     `{ ok:true, was_speaking }`) on success.
 */
export async function handleLiveStreamSend(
  req: AuthenticatedRequest,
  res: Response,
): Promise<Response> {
  const deps = getDeps();
  const { session_id } = req.query;
  const body = req.body as LiveStreamMessage & { session_id?: string };
  const effectiveSessionId = (session_id as string) || body.session_id;

  // VTID-ORBC: Resolve identity - JWT if present, DEV_IDENTITY in dev-sandbox, or anonymous.
  const identity = await deps.resolveOrbIdentity(req);

  if (!effectiveSessionId) {
    return res.status(400).json({ ok: false, error: 'session_id required' });
  }

  const session = liveSessions.get(effectiveSessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: 'Session not found' });
  }

  if (!session.active) {
    return res.status(400).json({ ok: false, error: 'Session not active' });
  }

  // VTID-ORBC: Log ownership mismatch but allow through — session IDs are UUIDs (unguessable).
  if (
    identity &&
    session.identity &&
    session.identity.user_id !== DEV_IDENTITY.USER_ID &&
    session.identity.user_id !== identity.user_id
  ) {
    console.warn(
      `[VTID-ORBC] /send ownership mismatch (allowed): session_user=${session.identity.user_id}, request_user=${identity.user_id}, session_tenant=${session.identity.tenant_id}, request_tenant=${identity.tenant_id}, sessionId=${effectiveSessionId}`,
    );
  }

  session.lastActivity = new Date();

  // VTID-ANON-NUDGE: Block all input after turn limit on anonymous sessions.
  if (session.isAnonymous && (session.turn_count > 8 || session.signupIntentDetected)) {
    return res.json({ ok: true });
  }

  try {
    if (body.type === 'audio') {
      // VTID-NAV: Drop mic audio once navigation is queued.
      if (session.navigationDispatched) {
        session.audioInChunks++;
        return res.json({ ok: true, dropped: true, reason: 'navigation_dispatched' });
      }

      // VTID-VOICE-INIT: Echo prevention gate (SSE path) — same as WebSocket path
      if (session.isModelSpeaking) {
        session.audioInChunks++;
        if (session.audioInChunks % 50 === 0) {
          console.log(`[VTID-VOICE-INIT] SSE path: dropping mic audio — model is speaking: session=${effectiveSessionId}`);
        }
        return res.json({ ok: true, dropped: true, reason: 'model_speaking' });
      }

      // VTID-ECHO-COOLDOWN: Post-turn cooldown drops mic for N ms.
      if (session.turnCompleteAt > 0 && (Date.now() - session.turnCompleteAt) < getPostTurnCooldownMs()) {
        session.audioInChunks++;
        return res.json({ ok: true, dropped: true, reason: 'post_turn_cooldown' });
      }

      session.audioInChunks++;

      // Telemetry: 10s window batching
      const now = Date.now();
      if (now - session.lastTelemetryEmitTime >= 10_000) {
        session.lastTelemetryEmitTime = now;
        deps.emitLiveSessionEvent('vtid.live.audio.in.chunk', {
          session_id: effectiveSessionId,
          chunk_number: session.audioInChunks,
          bytes: body.data_b64.length,
          rate: 16000,
        }).catch(() => {});
      }

      // VTID-01219: Forward audio to Vertex Live API WebSocket
      if (session.upstreamWs && session.upstreamWs.readyState === WebSocketPkg.OPEN) {
        const sent = deps.sendAudioToLiveAPI(
          session.upstreamWs,
          body.data_b64,
          body.mime || 'audio/pcm;rate=16000',
        );
        if (sent) {
          // VTID-VOICE-FWD (Track A): forwarded-only count (SSE path mirror of
          // the WS path in orb-live.ts). Only chunks the model actually
          // received; the three drop gates above return before reaching here.
          session.audioInForwarded++;
          session.lastAudioForwardedTime = Date.now();
          // VTID-FORWARDING-WATCHDOG + VTID-01984 (R5) sliding logic
          if (!session.isModelSpeaking) {
            if (session.vertexHasShownLife) {
              if (session.audioInChunks % 200 === 0) {
                deps.emitDiag(session, 'watchdog_skipped', { reason: 'vertex_alive' });
              }
            } else {
              const canSlide = !session.responseWatchdogTimer
                || session.responseWatchdogReason === 'forwarding_no_ack';
              if (canSlide) {
                deps.startResponseWatchdog(session, getForwardingAckTimeoutMs(), 'forwarding_no_ack');
              }
            }
          }
          // Periodic forward diagnostic
          if (session.audioInChunks % 100 === 0) {
            deps.emitDiag(session, 'audio_forwarding', { chunk: session.audioInChunks });
          }
        } else {
          console.warn(`[VTID-01219] Failed to forward audio chunk: session=${effectiveSessionId}`);
          if (session.audioInChunks % 50 === 0) {
            deps.emitDiag(session, 'audio_forward_failed', {
              chunk: session.audioInChunks,
              ws_state: session.upstreamWs?.readyState ?? -1,
            });
          }
        }
      } else {
        // Fallback: Log when Live API not connected
        if (session.audioInChunks % 50 === 0) {
          console.log(`[VTID-ORBC] Audio NO-LIVE-API: session=${effectiveSessionId}, chunk=${session.audioInChunks}, wsState=${session.upstreamWs?.readyState ?? 'NULL'}, projectId=${VERTEX_PROJECT_ID || 'EMPTY'}, hasAuth=${deps.getGoogleAuthReady()}`);
          deps.emitDiag(session, 'audio_no_ws', { chunk: session.audioInChunks });
        }

        // Send acknowledgment via SSE (fallback behavior)
        if (session.sseResponse && session.audioInChunks % 5 === 0) {
          session.sseResponse.write(`data: ${JSON.stringify({
            type: 'audio_ack',
            chunk_number: session.audioInChunks,
            live_api: false,
          })}\n\n`);
        }
      }
    } else if (body.type === 'video') {
      // Handle video frame
      session.videoInFrames++;
      const videoBody = body as LiveStreamVideoFrame;

      // Telemetry: reuse the same 10s window as audio
      const vidNow = Date.now();
      if (vidNow - session.lastTelemetryEmitTime >= 10_000) {
        session.lastTelemetryEmitTime = vidNow;
        deps.emitLiveSessionEvent('vtid.live.video.in.frame', {
          session_id: effectiveSessionId,
          source: videoBody.source,
          frame_number: session.videoInFrames,
          bytes: videoBody.data_b64.length,
          fps: 1,
        }).catch(() => {});
      }

      console.log(`[VTID-01155] Video frame received: session=${effectiveSessionId}, source=${videoBody.source}, frame=${session.videoInFrames}`);

      // Acknowledge frame receipt via SSE
      if (session.sseResponse) {
        session.sseResponse.write(`data: ${JSON.stringify({
          type: 'video_ack',
          source: videoBody.source,
          frame_number: session.videoInFrames,
        })}\n\n`);
      }
    } else if ((body as any).type === 'text' && (body as any).text) {
      // Handle text message - forward to Live API as client_content
      const textContent = (body as any).text as string;

      // VTID-ANON-NUDGE: Block text input after turn limit (SSE text path)
      if (session.isAnonymous && (session.turn_count > 8 || session.signupIntentDetected)) {
        return res.json({ ok: true });
      }

      // If this is a client-side greeting request and server already sent one, skip it
      if (session.greetingSent && textContent.toLowerCase().includes('greet')) {
        console.log(`[VTID-VOICE-INIT] Skipping client greeting request - server greeting already sent`);
        return res.status(200).json({ ok: true, note: 'Server greeting already in progress' });
      }

      if (session.upstreamWs && session.upstreamWs.readyState === WebSocketPkg.OPEN) {
        const textMessage = {
          client_content: {
            turns: [{ role: 'user', parts: [{ text: textContent }] }],
            turn_complete: true,
          },
        };
        session.upstreamWs.send(JSON.stringify(textMessage));
        console.log(`[VTID-VOICE-INIT] Text message forwarded to Live API: "${textContent.substring(0, 80)}..."`);
      } else {
        console.warn(`[VTID-VOICE-INIT] Cannot forward text - Live API not connected`);
      }
    } else if ((body as any).type === 'interrupt') {
      // VTID-VOICE-INIT: Client-side VAD detected real user speech during model playback
      if (!session.isModelSpeaking) {
        return res.json({ ok: true, was_speaking: false });
      }

      console.log(`[VTID-VOICE-INIT] SSE path: client interrupt — ungating mic and stopping Gemini: session=${effectiveSessionId}`);

      // Ungate mic audio
      session.isModelSpeaking = false;

      // Tell Gemini to stop generating
      if (session.upstreamWs && session.upstreamWs.readyState === WebSocketPkg.OPEN) {
        deps.sendEndOfTurn(session.upstreamWs);
      }

      // Clear incomplete output transcript
      session.outputTranscriptBuffer = '';

      // Send interrupted event to client via SSE
      if (session.sseResponse) {
        session.sseResponse.write(`data: ${JSON.stringify({ type: 'interrupted' })}\n\n`);
      }

      return res.json({ ok: true, was_speaking: true });
    }

    return res.status(200).json({ ok: true });
  } catch (error: any) {
    console.error(`[VTID-01155] Stream send error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
}
