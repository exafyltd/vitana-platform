# VTID-04386 — Orchestrator v2 P3: voice delegation goes async

Plan: `docs/ORCHESTRATOR-REDESIGN-PLAN.md` §3.4 pattern 3, and the P3 exit criteria in §5:
- a voice request needing more than 1.5 s acknowledges at once and delivers its result on a later turn;
- "stop that" cancels;
- a backoffice result is not spoken in a community session.

Builds on the dispatcher (VTID-04375).

## Acceptance criteria

AC-1 The Command Hub voice catalog declares `operator_delegate`, `get_delegation_result` and `cancel_delegation`, each once. The community and commerce catalogs declare none of them.
TEST: services/gateway/test/orb/live/vtid-04386-voice-delegation.test.ts

AC-2 `operator_delegate` answers inside the 1.5 s voice ack window. A slow Operator turn returns `working` with a job id at once; before this change it blocked for up to 25 s.
TEST: services/gateway/test/orb/live/vtid-04386-voice-delegation.test.ts

AC-3 `get_delegation_result` returns the result on a later turn, by id or the latest job when no id is given. `cancel_delegation` stops the job, and its late result is never reported.
TEST: services/gateway/test/orb/live/vtid-04386-voice-delegation.test.ts

AC-4 A job is never readable or cancellable from another surface or by another user.
TEST: services/gateway/test/orb/live/vtid-04386-voice-delegation.test.ts

AC-5 Role resolution:
- A verified exafy_admin in the Command Hub is the developer role for policy.
- A non-admin there is refused by policy.
- Outside the Command Hub, `operator_delegate` is refused.
TEST: services/gateway/test/orb/live/vtid-04386-voice-delegation.test.ts

AC-6 `orb-live.ts` dispatches all three tool names to `delegation-tools.ts`. The Command Hub prompt tells the model, as intent (NEVER rule 41), to acknowledge, fetch on a later turn, and cancel on request. The VTID-04310 contract (one `operator_delegate`, retired legacy tools, budget) still holds.
TEST: services/gateway/test/vtid-04310-command-hub-voice-operator-delegate.test.ts

## Not verified live

Staging cannot place ECS tasks (AWS account block since 2026-09-22 22:57 UTC), so no Command Hub voice session has exercised this. The first real signal is a Command Hub voice request to the Operator that returns within about 1.5 s, followed by a later `get_delegation_result` that carries the Operator's reply. Cancel stays cooperative: the Operator turn itself runs to its end, and its result is discarded (VTID-04375 known limit).
