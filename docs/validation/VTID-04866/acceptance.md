# VTID-04866 — Prod uses the WebSocket voice transport, so a deploy cannot split a session

Production, 2026-10-03, rolling deploy of `eaed51e` (`vitana-gateway-awsdr`). From 20:56:30 to 20:57:16 UTC two tasks were registered behind `vitana-tg-gateway-awsdr` (round_robin, stickiness off).
- On SSE, a voice session is `POST /session/start`, one `GET /orb/live/stream` and about 15 `POST /live/stream/send` per second. The ALB routes each of these on its own, but the session lives in one task's memory.
- Member session `live-ca850d2e` started on task `…7b1b2b`, and its stream landed on task `…723d52`.
- In `live-49d3b941`, audio POSTs alternated between the two tasks.
- The widget's 404 re-register budget (VTID-02034b, 2 per 30 s) ran out: 6 sessions in about 80 s, all ending after 1–26 s.

The WebSocket transport (VTID-03471) carries the whole session on one connection pinned to one task. It is the staging default (VTID-03791), and the prod `/orb/live/ws` endpoint already carries 15–57 connections a day (CloudWatch Logs Insights, 30 days). Owner decision 2026-10-03: turn it on in prod.

AC-1: The prod deploy workflow strips and re-adds `FEATURE_ORB_WS_TRANSPORT_ENV="staging+prod"`, so `GET /api/v1/orb/live/transport` answers `ws` on prod.
TEST: services/gateway/test/orb/live/upstream/staging-ws-transport-flag-pinned.test.ts

AC-2: The pin runs before `env_overrides` is applied, so a one-dispatch `{"FEATURE_ORB_WS_TRANSPORT_ENV":"off"}` still turns it off.
TEST: services/gateway/test/orb/live/upstream/staging-ws-transport-flag-pinned.test.ts

AC-3: Staging stays on `staging-only`, and the generated flag pins mirror both workflows.
TEST: services/gateway/test/services/conversation/vtid-04525-conversation-flag-registry.test.ts

AC-4: The edited deploy step is still valid bash and under GitHub's 20,000-character run-step limit.
TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts

AC-5: Staging still tells browsers to use `ws` after deploy (read-only).
CURL: GET https://preview-aws-gateway.vitanaland.com/api/v1/orb/live/transport -> {"ok":true,"transport":"ws"}
