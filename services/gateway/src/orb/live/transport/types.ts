/**
 * A9.1 (orb-live-refactor / VTID-02957): transport-neutral handler boundary.
 *
 * Each ORB transport (WebSocket today; SSE + REST-stream next in A9.2)
 * attaches to the shared HTTP server, accepts a client, and forwards each
 * accepted connection into the per-connection handler that lives in
 * `routes/orb-live.ts`. Transport modules own ONLY the attach/upgrade and
 * server-level error glue. Session state, message dispatch, and lifecycle
 * stay with orb-live.ts and move into `orb/live/session/*` under A8.
 *
 * Hard rules:
 *   1. Transport modules are stateless. No `Map`s of sessions live here.
 *   2. Wire protocol is byte-for-byte identical to the legacy path —
 *      same upgrade URL, same JSON envelope, same close codes.
 *   3. Dependencies are injected via the deps object. Transport modules
 *      do NOT import session-level helpers (`cleanupWsSession`,
 *      `liveSessions`, etc.).
 */

import type { Server as HttpServer, IncomingMessage } from 'http';
import type WebSocket from 'ws';
import type { WebSocketServer } from 'ws';

/**
 * Per-connection handler. Called once per upgraded WebSocket.
 *
 * Implementations own the per-connection state machine (auth extraction,
 * `ws.on('message')` registration, ping interval, close cleanup). The
 * transport module guarantees only that this function is called for every
 * new connection and that the (ws, req) tuple is forwarded unchanged.
 */
export type OrbWebSocketConnectionHandler = (
  ws: WebSocket,
  req: IncomingMessage,
) => void | Promise<void>;

/**
 * Dependencies for `mountOrbWebSocketTransport`.
 *
 * Typed deps replace the legacy reliance on file-scoped helpers in
 * `routes/orb-live.ts`. Tests can pass any handler; orb-live.ts injects
 * the real `handleWebSocketConnection`.
 */
export interface OrbWebSocketTransportDeps {
  /**
   * Per-connection handler. Receives every upgraded socket + upgrade
   * request. The transport module does not interpret message frames —
   * those flow through this handler's own `ws.on('message')`.
   */
  handleConnection: OrbWebSocketConnectionHandler;

  /**
   * Mount path for the WebSocket upgrade. Defaults to the legacy
   * `/api/v1/orb/live/ws`. Override only for tests or alternate
   * deployments — production clients connect to the default.
   */
  path?: string;

  /**
   * Server-level error sink. Called when the underlying WebSocketServer
   * emits an `error` event (distinct from per-connection errors, which
   * surface inside `handleConnection`). Defaults to `console.error`.
   */
  onServerError?: (err: Error) => void;
}

/**
 * Handle returned by `mountOrbWebSocketTransport`. Exposes the underlying
 * server for diagnostics + a tear-down hook. Idempotent.
 */
export interface OrbWebSocketTransport {
  /** The underlying `ws` WebSocketServer. Mainly for tests + diagnostics. */
  readonly server: WebSocketServer;

  /**
   * Mount path the transport is listening on (post-default resolution).
   */
  readonly path: string;

  /**
   * Tear down the transport. Closes the WebSocketServer; safe to call
   * multiple times.
   */
  close(): Promise<void>;
}

/**
 * Mount the WebSocket transport on the supplied HTTP server. The transport
 * shares the HTTP listener — no separate port, no separate `listen()`.
 *
 * Implementations: `orb/live/transport/websocket-handler.ts`.
 */
export type MountOrbWebSocketTransport = (
  httpServer: HttpServer,
  deps: OrbWebSocketTransportDeps,
) => OrbWebSocketTransport;
