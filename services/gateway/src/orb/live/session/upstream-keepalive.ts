/**
 * VTID-03234 (report finding #3) — upstream Vertex keepalive.
 *
 * Vertex closes the audio stream with code=1000 after ~25-30s of no audio,
 * and idle WS connections can be dropped by intermediaries. Two timers keep
 * the upstream alive during natural conversational pauses:
 *   - a 25s WS ping, and
 *   - a silence keepalive that feeds a tiny PCM silence frame when no real
 *     audio has been forwarded for >= the idle threshold (and the model is
 *     not currently speaking).
 *
 * This logic used to be armed inside the upstream message handler's
 * `setup_complete` branch. After the VertexLiveClient refactor (A8.3b.1)
 * VertexLiveClient consumes `setup_complete` and never dispatches it to the
 * legacy handler, so that branch is UNREACHABLE on the Vertex path — the
 * keepalive silently stopped being armed, and quiet pauses started causing
 * upstream closes that the client surfaced as "internet issues."
 *
 * This module restores the keepalive as a single testable unit that
 * `connectToLiveAPI` arms immediately after `vertex.connect()` resolves.
 */

import WebSocket from 'ws';
import {
  getSilenceKeepaliveIntervalMs,
  getSilenceIdleThresholdMs,
  SILENCE_AUDIO_B64,
} from '../../upstream/constants';

/** The subset of GeminiLiveSession the keepalive reads/writes. */
export interface KeepaliveSession {
  sessionId: string;
  active: boolean;
  isModelSpeaking?: boolean;
  lastAudioForwardedTime?: number;
  upstreamPingInterval?: ReturnType<typeof setInterval>;
  silenceKeepaliveInterval?: ReturnType<typeof setInterval>;
}

export interface KeepaliveDeps {
  /** Sends a base64 PCM frame upstream (orb-live.ts local). */
  sendAudioToLiveAPI: (ws: WebSocket, audioB64: string, mimeType?: string) => boolean;
  /** Override the 25s ping cadence (tests). */
  pingIntervalMs?: number;
}

const DEFAULT_PING_INTERVAL_MS = 25_000;

/** Clear both keepalive intervals (idempotent). */
export function clearUpstreamKeepalive(session: KeepaliveSession): void {
  if (session.upstreamPingInterval) {
    clearInterval(session.upstreamPingInterval);
    session.upstreamPingInterval = undefined;
  }
  if (session.silenceKeepaliveInterval) {
    clearInterval(session.silenceKeepaliveInterval);
    session.silenceKeepaliveInterval = undefined;
  }
}

/**
 * Arm the upstream ping + silence keepalive on `session`, bound to `ws`.
 * Idempotent: clears any existing timers first. Call once per upstream
 * connection, immediately after the Vertex setup handshake resolves.
 */
export function armUpstreamKeepalive(
  ws: WebSocket,
  session: KeepaliveSession,
  deps: KeepaliveDeps,
): void {
  clearUpstreamKeepalive(session);

  const pingMs = deps.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;

  // 25s WS ping — keeps the connection from being dropped as idle.
  session.upstreamPingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.ping();
      } catch {
        /* socket closing — ignore */
      }
    }
  }, pingMs);

  // Silence keepalive — feed a tiny PCM silence frame during quiet pauses so
  // Vertex doesn't idle-close the audio stream. Never during model speech
  // (would glitch Vertex VAD); never counts as real audio.
  if (typeof session.lastAudioForwardedTime !== 'number') {
    session.lastAudioForwardedTime = Date.now();
  }
  session.silenceKeepaliveInterval = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN || !session.active) return;
    if (session.isModelSpeaking) return;
    const idleMs = Date.now() - (session.lastAudioForwardedTime ?? 0);
    if (idleMs >= getSilenceIdleThresholdMs()) {
      try {
        deps.sendAudioToLiveAPI(ws, SILENCE_AUDIO_B64, 'audio/pcm;rate=16000');
        // Don't update lastAudioForwardedTime — silence isn't real audio.
      } catch {
        /* socket closing — ignore */
      }
    }
  }, getSilenceKeepaliveIntervalMs());
}
