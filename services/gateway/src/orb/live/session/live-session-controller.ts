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
  VAD_SILENCE_DURATION_MS_DEFAULT,
  POST_TURN_COOLDOWN_MS,
  FORWARDING_ACK_TIMEOUT_MS,
} from '../../upstream/constants';
import { destroySessionBuffer } from '../../../services/session-memory-buffer';
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

  if (isAnonymousSession) {
    contextBootstrapSkippedReason = 'anonymous_session';
    console.log(`[VTID-ANON] Anonymous session ${sessionId} — skipping memory, tools, lastSessionInfo. Context: city=${clientContext.city || 'unknown'}`);
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
              const { buildBrainSystemInstruction } = await import('../../../services/vitana-brain');
              const bodyRoute = typeof (body as any).current_route === 'string' ? (body as any).current_route : '';
              const brainRole = clientContext.isMobile
                ? 'community'
                : bodyRoute.startsWith('/command-hub')
                  ? 'developer'
                  : ((bootstrapIdentity as any).active_role || 'community');
              const { instruction, contextPack: cp } = await buildBrainSystemInstruction({
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
    ]);

    contextReadyPromise = bootstrapWork
      .then(async ([bootstrapResult, fetchedSseRole, fetchedSessionInfo, storedLangResult, adminBriefing]) => {
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
      ? (body as any).vad_silence_ms : VAD_SILENCE_DURATION_MS_DEFAULT,
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
  let wakeBriefDecision: Awaited<ReturnType<typeof decideWakeBriefForSession>> | null = null;
  try {
    const temporal = deps.describeTimeSince(session.lastSessionInfo);
    wakeBriefDecision = await decideWakeBriefForSession({
      sessionId,
      tenantId: orbIdentity?.tenant_id ?? null,
      userId: orbIdentity?.user_id ?? null,
      bucket: temporal.bucket,
      wasFailure: temporal.wasFailure,
      isReconnect: isReconnectStart,
      lang,
    });
    (session as any).wakeBriefDecision = wakeBriefDecision;
  } catch (e) {
    console.warn(
      `[VTID-02918] wake-brief decision failed for ${sessionId}: ${(e as Error).message}`,
    );
  }

  // Emit OASIS event with identity context
  await deps.emitLiveSessionEvent('vtid.live.session.start', {
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
      context_bootstrap: {
        latency_ms: contextBootstrapLatencyMs ?? null,
        context_chars: null,
        skipped_reason: contextBootstrapSkippedReason || null,
        deferred: !!contextReadyPromise,
      },
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
    video_in_frames: session.videoInFrames,
    audio_out_chunks: session.audioOutChunks,
    duration_ms: Date.now() - session.createdAt.getTime(),
    turn_count: session.turn_count,
    user_turns: session.transcriptTurns.filter((t) => t.role === 'user').length,
    model_turns: session.transcriptTurns.filter((t) => t.role === 'assistant').length,
  });

  // VTID-01959: voice self-healing dispatch (mode-gated for /report path).
  // VTID-01994: pass session metrics for mode-independent quality classifier.
  dispatchVoiceFailureFireAndForget({
    sessionId: session_id,
    tenantScope: session.identity?.tenant_id || 'global',
    metadata: { synthetic: (session as any).synthetic === true },
    sessionMetrics: {
      audio_in_chunks: session.audioInChunks,
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
      if (session.turnCompleteAt > 0 && (Date.now() - session.turnCompleteAt) < POST_TURN_COOLDOWN_MS) {
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
                deps.startResponseWatchdog(session, FORWARDING_ACK_TIMEOUT_MS, 'forwarding_no_ack');
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
