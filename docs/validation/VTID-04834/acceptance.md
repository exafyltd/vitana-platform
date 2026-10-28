# VTID-04834 — WS voice sessions emitted two `vtid.live.session.start` (and the stop_session path a second stop)

Measured on production `oasis_events` (48 h to 2026-10-02, read-only; evidence:
`outputs/prod-evidence-readonly.txt`): 9 WS sessions produced 18 start rows —
9 with `transport:'ws'`, 9 with `transport:'websocket'`, same session ids.
Every WS `stop_session` stop was filed under the `ws-<uuid>` socket id and was
followed ~2 min later by an `idle_no_engagement` stop for the live id.

Root causes (origin/main line numbers):

1. **Two start emits for one WS session.** `handleLiveSessionStart`
   (`orb/live/session/live-session-controller.ts:2543`, `transport:'ws'`,
   reached via `ws-start-adapter.ts`) is the canonical start since VTID-03471,
   but `handleWsStartMessage` (`routes/orb-live.ts:18945`,
   `transport:'websocket'`) kept its own start emit after the upstream
   connected, 0.4–0.8 s later.
2. **WS `stop_session` used the socket id.** `handleWsStopSession`
   (`routes/orb-live.ts:19400`) destructured `sessionId` from the WS client
   session (`ws-<uuid>`), emitted the stop under it (`:19441`) and ran
   `liveSessions.delete(sessionId)` (`:19481`), which deleted nothing. The live
   session stayed in `liveSessions` and the idle sweep (`:1480`, emit `:1501`)
   — which never checked the VTID-03561 `stopEventEmitted` latch — booked a
   second stop. The supersede path (`:1611`) and `POST /live/session/stop`
   (controller `:2762`) did not check the latch either.

Fix: the controller emit is the only start emit; the WS-only fields
(`nova_voice`, `nova_language_supported`, the Live-API voice as
`live_api_voice`, `authenticated`, `context_bootstrap.{included,latency_ms,
skipped_reason,memory_hits,knowledge_hits,tools_enabled}`) are merged into it,
plus `response_modalities`. `handleWsStopSession` uses the live id for the
event, the facts end, the self-healing dispatch and the delete. Every stop site
checks and latches `stopEventEmitted` before emitting.

**Canonical transport label.** `metadata.transport` on `vtid.live.session.*`
is `'websocket' | 'sse'` (`oasisTransportLabel()` in the controller): every
stop site and the `orb.live.*` latency / wake-timeline topics already used
`'websocket'`, and the Voice Lab reads `startEvent.metadata.transport` as
`'websocket' | 'sse' | 'livekit'`. Only the controller's start used `'ws'`.
`voice_session_facts.transport` keeps its DB CHECK short form
(`'ws'|'sse'|'livekit'`; `toFactsTransport` accepts both). The supersede and
`POST /live/session/stop` stops now carry `transport` too (prod showed 29 such
stops with null transport).

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: A WS session start (through `startLiveSessionForWs`) emits exactly one `vtid.live.session.start`, with `transport:'websocket'`, the controller fields (tenant/active_role/surface/origin/user_agent/lang) and the merged WS fields (`nova_voice`, `nova_language_supported`, `live_api_voice`, `authenticated`, `context_bootstrap` with memory/knowledge hit counts).
  TEST: services/gateway/test/vtid-04834-live-session-start-stop-once.test.ts
  TEST: services/gateway/test/orb/routes/session-start-voice-telemetry.test.ts
AC-2: An SSE start still emits exactly one start with `transport:'sse'`; orb-live.ts contains no `vtid.live.session.start` emit and the controller exactly one.
  TEST: services/gateway/test/vtid-04834-live-session-start-stop-once.test.ts
  TEST: services/gateway/test/orb/live/session/live-session-controller.test.ts
AC-3: The WS `stop_session` frame emits one stop under the LIVE session id (reason `ws_stop_session`, transport `websocket`), records the facts end for that id and removes the live session from `liveSessions`.
  TEST: services/gateway/test/vtid-04834-live-session-start-stop-once.test.ts
AC-4: The production sequence — `stop_session`, socket close, idle sweep, a late `POST /live/session/stop` — yields exactly one stop and one facts end; the idle sweep, supersede and POST stop paths skip a session whose `stopEventEmitted` latch is set; the sweep still reports an unreported idle session exactly once.
  TEST: services/gateway/test/vtid-04834-live-session-start-stop-once.test.ts
  TEST: services/gateway/test/vtid-04785-session-end-telemetry.test.ts
AC-5: No voice payload change: VTID-04542 payload identity snapshots unchanged (not updated); role / support / operator regression suites and the full gateway suite green.
  TEST: services/gateway/test/orb/latency/vtid-04542-voice-payload-identity.test.ts
  TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts
  TEST: services/gateway/test/vtid-04456-customer-support-pipeline-regression.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/orb/live/session/live-session-controller.ts (merged start emit, `oasisTransportLabel`, POST-stop latch + transport)
- services/gateway/src/routes/orb-live.ts (WS start emit removed; `handleWsStopSession` live id + latch; idle sweep extracted to `sweepIdleLiveSessions` + latch; supersede latch + transport; test-only re-export)
- services/gateway/test/vtid-04834-live-session-start-stop-once.test.ts (new)
- services/gateway/test/orb/routes/session-start-voice-telemetry.test.ts (follows the voice fields to the controller emit; Live-API voice now `live_api_voice`)
- docs/validation/VTID-04834/**

No route, schema, migration, wire-protocol or client change. The `session_started` WS frame is unchanged.

## OASIS

OASIS_PROOF: no new topic. `vtid.live.session.start`: one row per session on both transports (WS was two); WS rows now carry `transport:'websocket'` (was `'ws'` on the controller row) plus `nova_voice`, `nova_language_supported`, `live_api_voice`, `authenticated`, `response_modalities`, `context_bootstrap`. `vtid.live.session.stop`: one row per session; WS `stop_session` rows carry the `live-` id (was `ws-`); supersede and POST-stop rows now carry `transport`. Expected on production after PUBLISH (read-only check): per `metadata->>'transport'`, count(start) = count(DISTINCT session_id); no stop with `session_id LIKE 'ws-%'`; starts ≈ stops per transport. Asserted in test/vtid-04834-live-session-start-stop-once.test.ts.
