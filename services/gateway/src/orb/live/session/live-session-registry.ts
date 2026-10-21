/**
 * A8.1 (orb-live-refactor / VTID-02959): session lifecycle controller shell —
 * registry of session Maps.
 *
 * What this owns:
 *   - `sessions` (legacy `OrbLiveSession` Map; pre-VTID-01155 path)
 *   - `liveSessions` (current `GeminiLiveSession` Map; ORB voice path)
 *   - `wsClientSessions` (WebSocket client tracking Map)
 *
 * What this does NOT own (yet — moves in A8.2 / A8.3):
 *   - Session start / create logic
 *   - Session attach / detach / close lifecycle
 *   - LiveAPI message handling that writes SSE events
 *   - `/live/stream/send` + `/live/stream/end-turn` action handlers
 *   - Replacement of `connectToLiveAPI` with `VertexLiveClient`
 *
 * A8.1 is the SHELL only — moving the Map declarations into this module
 * makes the controller the canonical owner of session state. A8.2 + A8.3
 * fill in the lifecycle methods that operate on these Maps. orb-live.ts
 * imports the Map values from here and continues to mutate them in
 * place; the Map instances themselves are unchanged (same identity).
 *
 * Hard rules (carried from A7 / A9.1 / A9.2):
 *   1. No behavior change. The Map instances exported here are the same
 *      Map instances that orb-live.ts used to declare locally — just
 *      sourced from a different module.
 *   2. Type definitions stay in `routes/orb-live.ts` for A8.1 (they
 *      reference deep coupling with the rest of the route file —
 *      `ContextPack`, `SupabaseIdentity`, `ClientContext`, etc.). The
 *      registry uses `import type` so runtime has no cycle.
 *   3. No imports from `orb-live.ts` other than the type-only Map
 *      generics. Runtime behavior is fully decoupled.
 */

import type {
  OrbLiveSession,
  GeminiLiveSession,
  WsClientSession,
} from '../../../routes/orb-live';

/**
 * Legacy `OrbLiveSession` registry — keyed by session ID.
 *
 * Used by the pre-VTID-01155 `/orb/live` SSE path (`GET /live`,
 * `POST /start`, `POST /audio`, `POST /text`, `POST /mute`,
 * `POST /stop`). Newer ORB voice traffic flows through `liveSessions`.
 */
export const sessions = new Map<string, OrbLiveSession>();

/**
 * Active Gemini Live API session registry — keyed by session ID.
 *
 * Current ORB voice path. Created by `POST /api/v1/orb/live/session/start`,
 * consumed by `/live/stream` SSE, `/live/stream/send` REST,
 * `/live/stream/end-turn` REST, the WebSocket `start` message, and
 * `POST /api/v1/orb/live/session/stop`.
 */
export const liveSessions = new Map<string, GeminiLiveSession>();

/**
 * Per-WebSocket-client tracking — keyed by WS-bound session ID.
 *
 * Distinct from `liveSessions` because a WebSocket client may exist
 * before a Gemini Live session is started (`{type:'start'}` message)
 * and may outlive it (`{type:'stop'}` then a new `{type:'start'}`).
 */
export const wsClientSessions = new Map<string, WsClientSession>();
