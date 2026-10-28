# VTID-04934 — Keep the ORB WebSocket transport off on production

Durable rollback of VTID-04866 (PR #3898). VTID-04866 pinned `FEATURE_ORB_WS_TRANSPORT_ENV="staging+prod"` in the prod deploy workflow. On production this broke member Orb sessions:

| | Sessions | Avg length | With a user turn |
|---|---|---|---|
| 2026-10-03, SSE | 15 | 33 s | 11 |
| 2026-10-04 16:09 UTC – 2026-10-07, WebSocket | ~190 | ~2 s | 0 |

Source: `oasis_events` topic `vtid.live.session.stop`, read-only.

Example member session `live-9ba11989` (iPhone app WebView, 2026-10-07 05:59 UTC): the widget ran `_hide()` 1.3 s after the tap, before `session_started` arrived. The `_sessionStartWs` bail then sent `{type:'stop'}`.

An env-only rollback (prod deploy run #374, `env_overrides={"FEATURE_ORB_WS_TRANSPORT_ENV":"off"}`) has been live since 2026-10-07 07:38 UTC. This change makes it durable, so the next PUBLISH cannot turn WebSocket back on. Plan sparring record: `plan-sparring.md`.

AC-1: The prod deploy workflow strips and re-adds `FEATURE_ORB_WS_TRANSPORT_ENV` as `"off"`. Neither `"staging+prod"` nor `"staging-only"` is pinned on prod.
TEST: services/gateway/test/orb/live/upstream/staging-ws-transport-flag-pinned.test.ts

AC-2: The pin runs before `env_overrides`, so a one-dispatch override still wins.
TEST: services/gateway/test/orb/live/upstream/staging-ws-transport-flag-pinned.test.ts

AC-3: Staging keeps `"staging-only"`, and the generated flag pins mirror both workflows (prod: `"off"`).
TEST: services/gateway/test/services/conversation/vtid-04525-conversation-flag-registry.test.ts

AC-4: The edited deploy step is valid bash and under the 20,000-character run-step limit.
TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts

AC-5: Production tells the widget to use SSE (read-only).
CURL: GET https://gateway.vitanaland.com/api/v1/orb/live/transport -> {"ok":true,"transport":"sse"} (true since 2026-10-07 07:38 UTC; re-checked after PUBLISH)

Out of scope (follow-up): why the widget hides during the WS handshake on mobile WebViews, and the deploy-overlap SSE split that VTID-04866 set out to fix.
