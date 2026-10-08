# VTID-05002 — Keep SSE ORB sessions alive while a gateway deploy runs two tasks

Plan D of the 2026-10-08 follow-ups to VTID-04934. Plan sparring record: `plan-sparring.md` (converged, 2 rounds, owner-approved).

Why: prod (`vitana-gateway-awsdr`) runs one task; a rolling deploy (min 100 % / max 200 %) registers two, and the target group round-robins with stickiness off. An SSE session lives in one task's in-process `liveSessions` Map, so about half of its POSTs hit the other task, get 404, and after two silent re-registers the widget shows the network alert. WebSocket was meant to remove this (VTID-04866) but is off on prod since VTID-04934, and SSE stays the WS fallback by design.

AC-1: A new SSE session id is `live-<uuid>` exactly as before unless `ORB_SSE_CROSS_TASK_FORWARD_ENABLED=true`, `GATEWAY_INTERNAL_TOKEN` is set and the task knows its own address; then it is `live-<uuid>.<owner>`, the owner being this task's `ip:port` encrypted with AES-256-GCM (key from the internal token via HKDF) — opaque to the client.
TEST: services/gateway/test/orb/vtid-05002-sse-cross-task-forward.test.ts

AC-2: With two tasks running, `POST /live/stream/send`, `POST /live/stream/end-turn`, `POST /live/session/stop` and `GET /live/stream` that land on the task without the session are served by the owning task (body, query and Authorization intact; the SSE response is streamed through).
TEST: services/gateway/test/orb/vtid-05002-sse-cross-task-forward.test.ts

AC-3: Safety — a forwarded request is never forwarded again; an id signed with another key, tampered with, or pointing outside RFC 1918 private IPv4 (e.g. 169.254.169.254) is refused with today's 404 and no outbound request; a dead owner falls back to today's 404.
TEST: services/gateway/test/orb/vtid-05002-sse-cross-task-forward.test.ts

AC-4: Flag off — behaviour is byte-identical to today, including for an id that carries an owner part.
TEST: services/gateway/test/orb/vtid-05002-sse-cross-task-forward.test.ts

AC-5: Staging pins `ORB_SSE_CROSS_TASK_FORWARD_ENABLED="true"` (strip + re-add); prod is not pinned (off) and builds its env from its own task definition, so the staging pin cannot reach prod. The deploy step stays valid bash and under the 20,000-character limit; the generated flag pins mirror the workflow.
TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts
TEST: services/gateway/test/services/conversation/vtid-04525-conversation-flag-registry.test.ts

AC-6: Staging (read-only): a forged owner tag on `GET /api/v1/orb/live/stream` returns the normal 404 JSON (no 502, no forward).
CURL: GET https://preview-aws-gateway.vitanaland.com/api/v1/orb/live/stream?session_id=live-00000000-0000-0000-0000-000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA -> 404 {"ok":false,"error":"Session not found"}

Prerequisite (already satisfied, no infra change): security group `sg-0fbcf7b59b1f0d685` (staging and prod gateway tasks) allows 8080 from itself — rule `sgr-0893fcd2586a7a51a`, `docs/validation/VTID-03840/outputs/19-staging-bootstrap.txt:5`.

Rollout: prod gets the pin in a separate change only after a real staging deploy shows forwarded requests succeeding (`[orb-forward] VTID-05002 ... status=200` lines in CloudWatch, read-only).
