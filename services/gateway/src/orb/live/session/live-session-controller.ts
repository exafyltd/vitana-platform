/**
 * A8.2 (orb-live-refactor / VTID-02961): session lifecycle controller —
 * slice 2 of 3.
 *
 * A8 is split per the spec's risk warning:
 *   A8.1 (shipped) — registry shell (Maps + types).
 *   A8.2 (this slice) — lifecycle/cleanup helpers + smallest session-action
 *                       handler (`/live/stream/end-turn`). Establishes the
 *                       controller module + deps-bag pattern. Per the
 *                       direction's "Keep scope tight" rule, the larger
 *                       handlers (`/live/session/start`, `/live/session/stop`,
 *                       `/live/stream/send`) follow in subsequent slices
 *                       using the same pattern.
 *   A8.3 (next)   — LiveAPI message-handler closure migration to
 *                   VertexLiveClient (A7); migrates per-event SSE writes to
 *                   `writeSseEvent` from A9.2; lifts remaining handlers.
 *
 * Hard rules (carried from A7 / A9.1 / A9.2 / A8.1):
 *   1. Zero behavior change. The lifted helpers operate on the SAME Map
 *      instances that orb-live.ts mutates, via the A8.1 registry.
 *   2. Deps are injected once via `configureLiveSessionController`. Helpers
 *      that read deps after configuration call `getDeps()`. Configuring twice
 *      is an explicit error (caught early so misconfigured tests / wiring
 *      fail loudly).
 *   3. No LiveAPI message-handler closure here — that's A8.3.
 *   4. No LiveKit adapter, no provider selection — those are L-lane work.
 */

import type { Response } from 'express';
import type WebSocket from 'ws';
import WebSocketPkg from 'ws';
import type {
  AuthenticatedRequest,
  SupabaseIdentity,
} from '../../../middleware/auth-supabase-jwt';
import type { GeminiLiveSession } from '../../../routes/orb-live';
import { SESSION_TIMEOUT_MS } from '../config';
import { destroySessionBuffer } from '../../../services/session-memory-buffer';
import {
  deduplicatedExtract,
  clearExtractionState,
} from '../../../services/extraction-dedup-manager';
import { DEV_IDENTITY } from '../../../services/orb-memory-bridge';
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
 * Each dep maps 1:1 to a private function in orb-live.ts that A8.3 (or
 * later) will lift out independently:
 *   - `resolveOrbIdentity` lives at routes/orb-live.ts:~458.
 *   - `clearResponseWatchdog` lives at routes/orb-live.ts:~7201.
 *   - `sendEndOfTurn` lives at routes/orb-live.ts:~7104.
 */
export interface LiveSessionControllerDeps {
  resolveOrbIdentity: (req: AuthenticatedRequest) => Promise<SupabaseIdentity | null>;
  clearResponseWatchdog: (session: GeminiLiveSession) => void;
  sendEndOfTurn: (ws: WebSocket) => boolean;
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
