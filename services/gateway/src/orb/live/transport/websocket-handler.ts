/**
 * A9.1 (orb-live-refactor / VTID-02957): WebSocket transport boundary.
 *
 * Mounts the ORB WebSocket upgrade endpoint on the shared HTTP server and
 * forwards each accepted connection to the per-connection handler supplied
 * by the caller (today: `handleWebSocketConnection` in `routes/orb-live.ts`).
 *
 * This module owns ONLY the attach + dispatch glue. It does NOT:
 *   - Hold per-session state (sessions live in `routes/orb-live.ts`; will move
 *     to `orb/live/session/*` under A8).
 *   - Read or write the JSON message envelope (per-connection handler does
 *     that; transport is wire-protocol-neutral inside the upgrade).
 *   - Close session-level resources (close handlers in the connection
 *     handler own those).
 *
 * Wire protocol parity with the legacy inline impl in `routes/orb-live.ts`:
 *   - Mount path: `/api/v1/orb/live/ws`
 *   - Attached to the existing HTTP listener (no separate port).
 *   - `connection` and `error` listeners registered on the `WebSocketServer`.
 */

import type { Server as HttpServer } from 'http';
import { WebSocketServer } from 'ws';
import type {
  OrbWebSocketTransport,
  OrbWebSocketTransportDeps,
} from './types';

/**
 * Canonical mount path. ORB widgets reconnect to this exact URL — never
 * change without coordinating a v1 release.
 */
export const ORB_WS_MOUNT_PATH = '/api/v1/orb/live/ws';

function defaultErrorSink(err: Error): void {
  console.error('[orb-transport-ws] WebSocketServer error:', err);
}

/**
 * Mount the ORB WebSocket transport on the supplied HTTP server.
 *
 * Behavior-identical to the legacy inline impl: shared HTTP listener,
 * same mount path, `connection` + `error` handlers, no separate port.
 */
export function mountOrbWebSocketTransport(
  httpServer: HttpServer,
  deps: OrbWebSocketTransportDeps,
): OrbWebSocketTransport {
  const path = deps.path ?? ORB_WS_MOUNT_PATH;
  const onServerError = deps.onServerError ?? defaultErrorSink;

  const wss = new WebSocketServer({
    server: httpServer,
    path,
  });

  wss.on('connection', (ws, req) => {
    // Fire-and-forget: the per-connection handler is async, but errors
    // it throws are its own to surface (typically through OASIS events
    // or by closing the socket with an error frame).
    Promise.resolve(deps.handleConnection(ws, req)).catch((err) => {
      console.error('[orb-transport-ws] handleConnection threw:', err);
    });
  });

  wss.on('error', (err) => {
    onServerError(err);
  });

  console.log(`[orb-transport-ws] mounted at ${path}`);

  let closed = false;
  return {
    server: wss,
    path,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
}
