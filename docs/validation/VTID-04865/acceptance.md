# VTID-04865 — An upstream that finishes connecting after the member left is closed, not attached

Production, 2026-10-03. Russian bridge session `live-48eea1b8` (`lang=ru`, Vertex Live):
- 18:25:54: the client's SSE stream closed. The close handler ran (`Cleaned up live session on SSE disconnect … remaining: 0`), but `session.upstreamWs` was still null because `connectToLiveAPI` was awaiting voice config and the context-ready promise.
- The connect then resolved, the greeting was generated into the closed stream (`Turn complete … turn 1, isGreeting=true`), and the upstream stayed open.
- 19:25:58: Google closed it with `1011 The service is currently unavailable`. That is 60 minutes of an open Vertex Live connection for no one. The gateway reapers could not see it because it was already out of `liveSessions`.

AC-1: When the session was deactivated or removed from `liveSessions` before the upstream connect resolves, the upstream is closed with `1000 client_disconnect` and never assigned to `session.upstreamWs`.
TEST: services/gateway/test/orb/live/session/vtid-04865-orphan-upstream-guard.test.ts

AC-2: A session replaced under the same id counts as gone, so a stale connect cannot attach to the new session.
TEST: services/gateway/test/orb/live/session/vtid-04865-orphan-upstream-guard.test.ts

AC-3: The guard is wired at both places `orb-live.ts` attaches an upstream after an await: the SSE connect (`liveApiPromise.then`) and `attemptTransparentReconnect` (which returns `false`).
TEST: services/gateway/test/orb/live/session/vtid-04865-orphan-upstream-guard.test.ts

AC-4: A healthy session is unchanged. The ORB session suites and every suite that inspects these attach sites pass as before.
TEST: services/gateway/test/orb/live/session/
