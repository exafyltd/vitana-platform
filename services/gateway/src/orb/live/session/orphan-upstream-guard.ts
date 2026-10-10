/**
 * VTID-04865: an upstream voice connection that finishes opening after the
 * member has already left must be closed, not attached.
 *
 * The SSE close handler (`routes/orb-live.ts`, `req.on('close')`) closes
 * `session.upstreamWs` and deletes the session from `liveSessions`. But
 * `connectToLiveAPI` is async: it awaits voice config, the context-ready
 * promise and the provider handshake before it resolves. When the client's
 * stream drops inside that window, the close handler finds no upstream to
 * close — and the connect then resolves and attaches a live upstream to a
 * session nobody holds any more. Production 2026-10-03: a Russian bridge
 * session (`live-48eea1b8…`) spoke its greeting into a closed stream and
 * held the Vertex Live connection for 60 minutes until Google ended it with
 * 1011. Nothing in the gateway's reapers can see it — the session is
 * already gone from the Map they sweep.
 */

export interface UpstreamLike {
  close(code?: number, reason?: string): void;
}

export interface SessionLike {
  active?: boolean;
}

/**
 * True when the session the connect was started for is no longer the live
 * one: deactivated by the SSE close / stop path, removed from the registry,
 * or replaced in it by a newer session under the same id.
 */
export function isSessionGone<S extends SessionLike>(
  session: S,
  sessionId: string,
  registry: Pick<Map<string, S>, 'get'>,
): boolean {
  if (session.active === false) return true;
  return registry.get(sessionId) !== session;
}

/**
 * Closes `ws` when the session is gone and reports whether it did. Callers
 * return immediately on `true` and never assign `ws` to the session.
 */
export function closeIfSessionGone<S extends SessionLike>(
  ws: UpstreamLike | null | undefined,
  session: S,
  sessionId: string,
  registry: Pick<Map<string, S>, 'get'>,
  where: string,
): boolean {
  if (!isSessionGone(session, sessionId, registry)) return false;
  console.warn(
    `[VTID-04865] upstream connected after session ${sessionId} ended (${where}) — closing it instead of attaching`,
  );
  if (ws) {
    try {
      ws.close(1000, 'client_disconnect');
    } catch {
      // already closing — nothing else holds a reference to it
    }
  }
  return true;
}
