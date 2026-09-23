# VTID-04339 — Conversation rebuild WS-0.1: close two unauthenticated routes, fix the assistant's brain identity

Plan v1 (Conversation Intelligence Rebuild), Phase 0, workstream WS-0.1.

## What was wrong (confirmed live on staging `e09eb264b689`, before this change)

1. `POST /api/v1/brain/test` (`index.ts`) had no auth. It runs a full brain
   turn — LLM spend plus memory reads/writes — for any `user_id` /
   `tenant_id` in the body. An anonymous POST with `{}` reached the handler
   and was stopped only by its own field check (400 JSON).
2. `GET /api/v1/voice/awareness/watchdogs` had no auth middleware. An
   anonymous GET returned 200 with operator telemetry.
3. `assistant-service.ts` routed through the Vitana brain with
   `user_id: finalSessionId` and `tenant_id` taken from the request body. The
   only caller (Command Hub Dev ORB) sends no login and `tenant: 'Vitana-Dev'`,
   so every brain turn ran against a random session UUID — memory lookups
   under a key no user owns. Not a cross-user leak, but a brain path that
   could never work.

## Fix

- `/brain/test`: `requireAuth` + `requireExafyAdmin` on the registration.
- `/voice/awareness/watchdogs`: `requireAuth` + `requireExafyAdmin`,
  per-handler (the router is mounted at `/api/v1`). The Command Hub already
  sends its bearer token on this call (`buildContextHeaders()`), so the
  Awareness tab keeps working for admins.
- `/assistant/chat`: `optionalAuth` (never rejects) attaches the verified
  identity; `processAssistantMessage` takes it as an optional argument and
  uses the brain only when both `user_id` and `tenant_id` are verified.
  Without an identity it takes the existing stateless path
  (`callViaRouter('operator')`) — the Command Hub Dev ORB lands there.

## Acceptance criteria

AC-1: An anonymous GET /voice/awareness/watchdogs is rejected with 401 and never reads telemetry.
TEST: services/gateway/test/routes/voice-awareness.test.ts

AC-2: An authenticated non-admin is rejected with 403; an exafy admin gets the statuses.
TEST: services/gateway/test/routes/voice-awareness.test.ts

AC-3: POST /brain/test is registered once, behind requireAuth then requireExafyAdmin.
TEST: services/gateway/test/vtid-04339-brain-test-route-auth.test.ts

AC-4: The assistant uses the brain only with a verified identity, and passes that identity's user_id and tenant_id (never the session id or the body tenant).
TEST: services/gateway/test/services/vtid-04339-assistant-brain-identity.test.ts

AC-5: Without an identity, without a tenant, or with the brain flag off, the assistant takes the stateless path.
TEST: services/gateway/test/services/vtid-04339-assistant-brain-identity.test.ts

AC-6 (post-deploy, staging): anonymous GET /voice/awareness/watchdogs returns 401 JSON; anonymous POST /brain/test returns 401 JSON; anonymous POST /assistant/chat still answers.
CURL: see "Post-deploy check" below — to be run after merge on preview-aws-gateway.

## Route evidence

Existing routes — only their middleware chains change. The PR also adds three
read-only admin routes for companion VTID-04371, listed after the curl proof.

ROUTE_MOUNT: `voice-awareness` router via `mountRouterSync(app, '/api/v1', voiceAwarenessRouter)` (index.ts); `/api/v1/brain/test` registered directly on `app` in index.ts; `assistant` router via `mountRouterSync(app, '/api/v1/assistant', assistantRouter)`.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/voice/awareness/watchdogs, https://preview-aws-gateway.vitanaland.com/api/v1/brain/test, https://preview-aws-gateway.vitanaland.com/api/v1/assistant/chat

CURL_PROOF: before this change, anonymous, against staging build `e09eb264b689`:

```
GET  /api/v1/voice/awareness/watchdogs -> 200 application/json; charset=utf-8
POST /api/v1/brain/test                -> 400 application/json; charset=utf-8
POST /api/v1/assistant/chat            -> 400 application/json; charset=utf-8
```

All three routes exist (JSON, not an HTML 404). The 200 and the 400 from
`/brain/test` are the defects: both were reachable without a login.

**Added by VTID-04371 (WS-0.7), same PR.** Three `router.get(...)` handlers in
`services/gateway/src/routes/conversation-hub.ts`, on the pre-existing
`conversation-hub` router (mounted at `/api/v1`), each behind
`requireAuth` + `requireExafyAdmin`:

- `https://preview-aws-gateway.vitanaland.com/api/v1/admin/conversation/metrics/summary`
- `https://preview-aws-gateway.vitanaland.com/api/v1/admin/conversation/metrics/series`
- `https://preview-aws-gateway.vitanaland.com/api/v1/admin/conversation/metrics/learning`

Pre-merge, anonymous, staging, 2026-09-23:

```
GET /api/v1/admin/conversation/metrics/summary -> 404 text/html; charset=utf-8   (not deployed yet)
GET /api/v1/admin/conversation/decisions       -> 401 application/json; charset=utf-8   (sibling on the same router: mounted, admin gate live)
```

Post-merge expectation: all three return `401 application/json` anonymously.

### Post-deploy check (AC-6)

```
B=https://preview-aws-gateway.vitanaland.com
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" "$B/api/v1/voice/awareness/watchdogs"                       # expect 401 application/json
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" -X POST "$B/api/v1/brain/test" -H 'Content-Type: application/json' -d '{}'   # expect 401 application/json
```

## OASIS evidence (whole PR)

OASIS_PROOF: new event types, each added to the `CicdEventType` union in
`services/gateway/src/types/cicd.ts` and each a state transition, never a poll
or heartbeat:
- `conversation.session.finalized` (VTID-04353): once per finalize run, after
  its writes settle. Payload `session_id, reason, turns, user_turns, duration_ms,
  memory_committed, summary_written, threads_written, threads_touched,
  promises_written`. TEST: services/gateway/test/orb/live/session/vtid-04353-finalize-live-session.test.ts
- `conversation.offer.{made,accepted,declined,ignored}` (VTID-04355): one per
  offer transition, payload `offer_id, source, provider, key, tool, offered_at`.
  TEST: services/gateway/test/services/assistant-continuation/vtid-04355-offer-outcomes.test.ts
- No new topic for VTID-04369 or VTID-04393: new fields on existing
  `orb.live.diag` stages (`failure_kind` on `upstream_error`, the Monitor
  columns on `greeting_sent`) and one new diag stage `brain_context_built`.
  TEST: services/gateway/test/orb/live/vtid-04369-failure-kind-and-monitor-fields.test.ts,
  services/gateway/test/orb/live/instruction/vtid-04393-bootstrap-packer.test.ts
- VTID-04371 emits nothing; it reads `oasis_events` by topic in an hourly rollup.
- No new topic for VTID-04399: one new `orb.live.diag` stage `core_snapshot_used`
  (the stream-open gate used the stored core snapshot) and a `context_source`
  field on the existing `context_awaited` / `setup_sent` latency marks.
  TEST: services/gateway/test/services/conversation/vtid-04399-brain-core-snapshot.test.ts

Live signal after merge (staging): rows with these topics in `oasis_events`.

## Not in scope

- `/assistant/chat` itself stays open (the Dev ORB relies on it without a
  login). It now never touches user memory without an identity. Requiring a
  login there is a separate decision.
