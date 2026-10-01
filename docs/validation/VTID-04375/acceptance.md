# VTID-04375 — Orchestrator v2 P3: dispatcher behind `delegate_to_agent`

Plan: `docs/ORCHESTRATOR-REDESIGN-PLAN.md` §3.4 (patterns 2 and 3), §5 P3. This slice is the dispatcher core plus its admin view. Wiring the voice tools (`delegate_to_agent` / `get_delegation_result` / `cancel_delegation`) into the live ORB catalog is the next slice.

## Acceptance criteria

AC-1 `delegateToAgent` refuses, without running anything:
- an unknown agent (and names the agents available on this surface);
- a surface the agent does not serve;
- an anonymous caller;
- an empty request.
TEST: services/gateway/test/services/orchestrator/vtid-04375-dispatcher.test.ts

AC-2 The capability policy decides. A role without authority in the target's domain is refused. A tier that the channel cannot confirm (for example commit by voice) escalates without running.
TEST: services/gateway/test/services/orchestrator/vtid-04375-dispatcher.test.ts

AC-3 Async pattern:
- A result inside the ack window (1.5 s for voice) is returned at once.
- A slow agent returns `working` with a job id at once, and the result is read on a later turn.
- A failure or throw is reported, never thrown.
TEST: services/gateway/test/services/orchestrator/vtid-04375-dispatcher.test.ts

AC-4 Cancel: a running job is marked cancelled, its late result is discarded, and the agent's AbortSignal fires.
TEST: services/gateway/test/services/orchestrator/vtid-04375-dispatcher.test.ts

AC-5 Isolation (plan P3 exit criterion): a job is readable and cancellable only by the same user on the same surface. A job created in backoffice is "not found" from a community (vitanaland) session and to any other user.
TEST: services/gateway/test/services/orchestrator/vtid-04375-dispatcher.test.ts

AC-6 The first target, `operator`, is available on command-hub only. It reuses the VTID-04310 operator turn with the caller's verified identity and operator thread, and a community member cannot reach it.
TEST: services/gateway/test/services/orchestrator/vtid-04375-dispatcher.test.ts

AC-7 `GET /api/v1/orchestrator/delegations` is exafy_admin only. It returns the delegation targets and in-memory job counts, never request text or results.
TEST: services/gateway/test/routes/orchestrator.test.ts

## Route evidence

ROUTE_MOUNT: `services/gateway/src/routes/orchestrator.ts` → `router.get('/delegations', requireDevRole, …)`, mounted at `/api/v1/orchestrator`.
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/orchestrator/delegations
CURL_PROOF: pending. Staging cannot place new ECS tasks (AWS account block since 2026-09-22 22:57 UTC). Expected: `401 application/json` without auth. Route behaviour is verified via supertest.

## Known limits (named, not hidden)

- Jobs live in process memory with a TTL (1 h, 1,000 jobs). ORB sessions are pinned to one gateway task, so a job lives on the task that serves the session. A deploy clears in-flight jobs. Persisting jobs as native `agent_runs` rows is P4.
- Cancel is cooperative. The operator turn does not take an AbortSignal yet, so a cancelled operator job runs to its end and its result is discarded.
