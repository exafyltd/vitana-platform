/**
 * A6.2 (orb-live-refactor): SessionMutator — the typed write surface
 * that complements SessionContext (A6.1).
 *
 * Per the approved plan + the user's late-2026-05-11 design note:
 *   "SessionContext = read-only state.
 *    SessionMutator = only write surface.
 *    Handlers never see GeminiLiveSession directly."
 *
 * Today (A6.2) only one method exists: `appendRecentRoute`. It's the
 * single state mutation handleGetCurrentScreen and friends need.
 * Future A6.3+ extractions extend this interface (add
 * `setCurrentRoute`, `appendTranscriptTurn`, `markNavigatorAction`,
 * etc.) as their handler bodies are lifted.
 *
 * **Hard rules carried forward through every A6.x PR:**
 *   - Mutator methods take primitives or small typed structs — no
 *     `Partial<GeminiLiveSession>` shapes.
 *   - Mutator methods return `void` (or a typed result for fallible
 *     ops). The handler doesn't see the session afterwards.
 *   - Implementation lives in `makeSessionMutator()` (this file) and
 *     does the raw mutation. orb-live.ts NEVER mutates session state
 *     directly from inside an extracted handler.
 */

/**
 * Typed write surface. Tool handlers receive an instance of this
 * (alongside a `SessionContext`) and use it for ALL session state
 * changes.
 */
export interface SessionMutator {
  /**
   * Update the user's recent-route trail. The mutator dedupes against
   * the existing trail and caps at 5 entries (same policy as the
   * pre-extraction inline mutation in `handleNavigate`).
   *
   * @param path React-Router path the user just navigated to.
   */
  appendRecentRoute(path: string): void;
}

/**
 * Build a `SessionMutator` from a live `GeminiLiveSession`-like object.
 *
 * We accept a structural shape (NOT importing `GeminiLiveSession`
 * directly) so this module doesn't pull route-file types into
 * `orb/live/session/`. orb-live.ts's compat shims pass the live
 * session object as-is.
 *
 * Concurrency note: mutations happen synchronously inside the handler's
 * `await` boundary. The session map is single-threaded per session-id
 * (Node event loop), so no lock is needed.
 */
export function makeSessionMutator(session: MutableSessionLike): SessionMutator {
  return {
    appendRecentRoute(path: string): void {
      if (typeof path !== 'string' || path.length === 0) {
        return;
      }
      const trail = Array.isArray(session.recent_routes)
        ? [...session.recent_routes]
        : [];
      const deduped = trail.filter((r) => r !== path);
      session.recent_routes = [path, ...deduped].slice(0, 5);
    },
  };
}

/**
 * Structural shape `makeSessionMutator` mutates.
 *
 * Intentionally a thin write-side mirror of `GeminiLiveSession`'s
 * relevant fields — handlers that consume `SessionMutator` never see
 * this type either, only the `SessionMutator` interface above.
 */
export interface MutableSessionLike {
  recent_routes?: string[];
}
