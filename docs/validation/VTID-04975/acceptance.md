# VTID-04975 - Kiro engine in the Command Hub Operator (Phase 1)

Owner decision 2026-10-08 (Gate 1 yes). Sparring: `plan-sparring.md` (converged, 3 rounds, standard class). Phase 1 stores no real key and ships inert (`KIRO_ENGINE_ENABLED` unset, no backend registered).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: `GET /api/v1/operator/kiro/status`, `POST /api/v1/operator/kiro/permissions/:requestId`, `POST /api/v1/operator/kiro/sessions/:threadId/cancel`, `DELETE /api/v1/operator/kiro/sessions/:threadId`, all `requireAdminAuth` on the existing operator router.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/operator/kiro/status (staging, unauthenticated GET).

OASIS_PROOF: answering a Kiro permission card emits `operator.kiro.permission_answered` and closing a session emits `operator.kiro.session_closed` (vtid VTID-04975; user id and request/thread id only, no key, prompt or tool arguments).

CURL_PROOF: unauthenticated `GET /api/v1/operator/kiro/status` answers 401 with application/json (route exists), not an HTML 404.

## Acceptance criteria

AC-1: ACP client speaks JSON-RPC over stdio (initialize, session/new, session/prompt, session/cancel), tolerates log noise, fails pending requests when the child exits, times out, and answers the agent's permission request (selected option, or cancelled).
  TEST: services/gateway/test/vtid-04975-kiro-engine.test.ts
AC-2: ACP updates map to the additive KiroTurnEvent type (message chunk, tool call, tool update), both spellings; OperatorTurnEvent is unchanged.
  TEST: services/gateway/test/vtid-04975-kiro-engine.test.ts
AC-3: Tool trust: read/search/think are allowed; anything else becomes an approval card, answered only by the session owner, denied on timeout or rejection.
  TEST: services/gateway/test/vtid-04975-kiro-engine.test.ts
AC-4: runKiroTurn is inert without the switch or a backend, returns the router-shaped result, reuses the session per thread, refuses another user, enforces per-user and global session caps, drops a failed session, and cancel/close are owner-only.
  TEST: services/gateway/test/vtid-04975-kiro-engine.test.ts
AC-5: The chat schema accepts `engine: llm|kiro` for a new thread; an existing thread keeps its engine; Kiro threads are exafy_admin only.
  TEST: services/gateway/test/vtid-04975-kiro-engine.test.ts
AC-6: The existing operator pipeline is unchanged for LLM threads.
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  TEST: services/gateway/test/vtid-04022-operator-threads.test.ts
  TEST: services/gateway/test/operator-chat-oasis.test.ts

## Not in this change
Phase 2 (kiro-runner service, Secrets Manager key vault, kiro_user_links, linking dstevanovic@hotmail.com) is gated on written Kiro/AWS terms confirmation. The Command Hub "Connect Kiro" panel follows in a later commit of the same plan.
