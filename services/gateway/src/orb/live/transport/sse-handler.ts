/**
 * A9.2 (orb-live-refactor / VTID-02958): SSE transport boundary.
 *
 * Pure helpers for the Server-Sent Events transport used by the ORB voice
 * pipeline. Two SSE upgrade points exist in `routes/orb-live.ts` today
 * (`GET /orb/live` legacy + `GET /orb/live/stream` current). Both share
 * the same wire format: a four-header upgrade + `data: ${JSON}\n\n`
 * events + a 10 s data heartbeat.
 *
 * This module owns ONLY the transport mechanics. It does NOT:
 *   - Reach into session state (`liveSessions`, `session.sseResponse = res`
 *     assignment, transcript buffers, etc.). Those stay in orb-live.ts and
 *     move under A8 (session lifecycle controller).
 *   - Build payloads. Callers decide which events to send; this module just
 *     encodes + writes them.
 *   - Know about Live API connection state, context-pack rebuilds, or
 *     greeting policy.
 *
 * Wire protocol parity with the legacy inline impl:
 *   - 4 SSE headers: `Content-Type: text/event-stream`,
 *     `Cache-Control: no-cache`, `Connection: keep-alive`,
 *     `X-Accel-Buffering: no`. Plus `flushHeaders()`.
 *   - Events: `data: ${JSON.stringify(payload)}\n\n`.
 *   - Heartbeat: `{ type: 'heartbeat', ts: <ms> }` every 10 s (data event,
 *     NOT an SSE comment — comments don't trigger EventSource.onmessage,
 *     which is the legacy `[VTID-HEARTBEAT-FIX]` reason).
 *   - No retry hint, no event name (only `data:`), no id.
 */

import type {
  SseEventPayload,
  SseHeartbeatHandle,
  SseHeartbeatOptions,
  SseResponseLike,
} from './types';

/**
 * Canonical SSE upgrade headers. Exported as a frozen array so tests can
 * assert on the exact set + value pairs without relying on the helper
 * having been called.
 */
export const SSE_HEADERS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ['Content-Type', 'text/event-stream'],
  ['Cache-Control', 'no-cache'],
  ['Connection', 'keep-alive'],
  ['X-Accel-Buffering', 'no'],
] as const);

/** Default heartbeat interval — matches the legacy `[VTID-HEARTBEAT-FIX]`. */
export const SSE_DEFAULT_HEARTBEAT_MS = 10_000;

/**
 * Apply the canonical SSE upgrade headers + flush. After this returns the
 * response is in streaming-SSE mode and the first `data:` frame may be
 * written.
 *
 * Idempotent header writes: if `setHeader` is called twice with the same
 * key Express overwrites silently — no-op for the caller.
 *
 * Does NOT write a status code: SSE responses are always `200 OK`, which
 * is the Express default. Calling `res.status(...)` before this is the
 * caller's choice (e.g., the legacy handlers return `403`/`404` BEFORE
 * upgrading; only `200` reaches this function).
 */
export function attachSseHeaders(res: SseResponseLike): void {
  for (const [name, value] of SSE_HEADERS) {
    res.setHeader(name, value);
  }
  res.flushHeaders?.();
}

/**
 * Encode an SSE event payload into the wire format.
 *
 * Format: `data: ${JSON.stringify(payload)}\n\n` — exactly what the
 * legacy inline writes use.
 */
export function encodeSseEvent(payload: SseEventPayload): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Safely write an SSE event. Returns true if the frame was queued for the
 * socket, false if the socket is already closed or `res.write` threw.
 *
 * Mirrors the legacy `try { sse.write(...) } catch { /* SSE closed *\/ }`
 * pattern that appears ~25× in `routes/orb-live.ts`.
 */
export function writeSseEvent(res: SseResponseLike, payload: SseEventPayload): boolean {
  if (res.writableEnded) return false;
  try {
    return res.write(encodeSseEvent(payload));
  } catch {
    return false;
  }
}

/**
 * Start the data-message heartbeat on an SSE response.
 *
 * The heartbeat is a real `data:` event (NOT an SSE `:` comment) so the
 * client's EventSource.onmessage fires and resets its watchdog. The
 * legacy code at line ~12086 of `routes/orb-live.ts` documents WHY:
 * a comment-style keepalive keeps the HTTP connection alive but does
 * NOT reset the client watchdog, so the user-visible "No response from
 * server" disconnects continued.
 *
 * The handle's `clear()` is idempotent. The interval auto-clears the
 * first time `writeSseEvent` returns false (i.e., the socket is gone),
 * matching the legacy `clearInterval(...)` in the catch arm.
 */
export function startSseHeartbeat(
  res: SseResponseLike,
  options: SseHeartbeatOptions = {},
): SseHeartbeatHandle {
  const intervalMs = options.intervalMs ?? SSE_DEFAULT_HEARTBEAT_MS;
  const type = options.type ?? 'heartbeat';
  const extend = options.extend;

  let cleared = false;
  const timer = setInterval(() => {
    const base: SseEventPayload = { type, ts: Date.now() };
    const payload: SseEventPayload = extend ? { ...base, ...extend() } : base;
    const ok = writeSseEvent(res, payload);
    if (!ok) {
      // Match legacy behavior: stop heartbeating the moment the
      // socket is gone. The caller's `req.on('close', ...)` may also
      // call `clear()` — both paths converge.
      cleared = true;
      clearInterval(timer);
    }
  }, intervalMs);

  // Don't keep the process alive just for heartbeats — matches the
  // implicit Node default for setInterval inside an HTTP request
  // handler, but be explicit so tests that exit early don't hang.
  if (typeof (timer as any).unref === 'function') {
    (timer as any).unref();
  }

  return {
    clear: () => {
      if (cleared) return;
      cleared = true;
      clearInterval(timer);
    },
    get active() {
      return !cleared;
    },
  };
}
