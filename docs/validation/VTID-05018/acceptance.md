# VTID-05018 - A Kiro thread keeps its conversation when its Kiro session reopens

Owner approval 2026-10-09 (Gate 1: "Yes, build it and ship."). Sparring: `plan-sparring.md` (converged, 2 rounds).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: none new. `POST /api/v1/operator/chat` (existing) passes a history loader to the Kiro turn.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/operator/chat (staging; behaviour proven by tests, a real Kiro turn writes thread rows).

CURL_PROOF: unauthenticated POST /api/v1/operator/chat stays refused (401 application/json) — the route's auth is unchanged.

OASIS_PROOF: the existing assistant chat event now carries `kiro_history_restored: <n>` in its metadata when a reopened session got the thread back.

## Acceptance criteria

AC-1: When a Kiro turn opens a NEW session for a thread with stored turns, its first prompt sends a marked "RESTORED THREAD HISTORY … context only" block (user/assistant text, newest kept, 1,500 chars per message, 12,000 total, omitted count) followed by the user's message as its own block.
  TEST: services/gateway/test/vtid-05018-kiro-thread-memory.test.ts
AC-2: A live session never loads history; a failed or empty load leaves the turn unchanged; a caller without a loader is unchanged.
  TEST: services/gateway/test/vtid-05018-kiro-thread-memory.test.ts
AC-3: End to end through the real chat route and thread store: a Kiro thread with stored turns and no live session restores them (no tool rows); another user's thread is never restored.
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  CURL: staging POST /api/v1/operator/chat without a caller -> 401 application/json
