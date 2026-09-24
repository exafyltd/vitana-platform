# VTID-04467 — Agent executions never fall back into the gateway process

Live evidence (2026-09-22 22:08 and 22:22 UTC, during the AWS account block): ECS refused every RunTask, so the dispatch loop fell back to running the agent inside the gateway. The gateway image is built with production dependencies only, so each run spent its whole LLM budget and then died at the runner's own check with `tsc failed after 3 fix round(s): spawn …/node_modules/.bin/tsc ENOENT`.

## Acceptance criteria

AC-1 A single-shot execution, or an agent run on a process that has the toolchain, runs in-process exactly as before.
TEST: services/gateway/test/vtid-04467-dispatch-fallback.test.ts

AC-2 An agent run on a process without the toolchain is requeued to `cooling`, with `execute_after` at 2, 4, 8 … minutes (capped at 30) and `metadata.dispatch_failures` counted. At `MAX_DISPATCH_ATTEMPTS` (3; `DEV_AUTOPILOT_MAX_DISPATCH_ATTEMPTS` sets it within 1..20) the run is failed instead.
TEST: services/gateway/test/vtid-04467-dispatch-fallback.test.ts

AC-3 The failure reason names the attempts and the dispatch error. It matches the retry breaker's outage pattern, so it never counts against the finding, and a streak of these halts claiming (VTID-04368).
TEST: services/gateway/test/vtid-04467-dispatch-fallback.test.ts

AC-4 The dispatch loop checks this decision before its in-process fallback. Requeue and fail both go through one helper that releases the run lease (VTID-04446) and emits `dev_autopilot.execution.dispatch_deferred` or `dev_autopilot.execution.dispatch_failed`. A dispatch failure never goes through `applyExecutionResult`, so no self-heal child is spawned for an infrastructure failure.
TEST: services/gateway/test/vtid-04467-dispatch-fallback.test.ts

AC-5 The toolchain probe checks for `tsc` in the node_modules the agent links into its clone, and for a working `git`. The answer is cached per process.
TEST: services/gateway/test/vtid-04467-dispatch-fallback.test.ts

## Not verified live

This path only fires when ECS refuses RunTask. The signal is a `dispatch_deferred` event on staging during such a refusal, instead of an in-process run that dies on `tsc ENOENT`.
