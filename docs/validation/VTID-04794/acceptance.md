# VTID-04794 — An empty reply cut off by the output cap is a failure, so the stage fallback runs

VALIDATION_PROFILE: gateway_backend

## Problem (found live on staging, VTID-04788)

Pipeline test ticket FB-2026-10-000144 reached auto-dispatch twice (14:14 and
14:18 UTC). Both times the bridge stopped at plan generation:
`bridge failed: plan generation failed: Plan generation failed after 39s: unknown error`.

It is not specific to that ticket. Over the 24 hours to 14:20 UTC the Dev
Autopilot planner recorded 47 `dev_autopilot.plan.failed` events, every one
"unknown error", against 11 `dev_autopilot.plan.generated`.

Root cause: the planner runs on DeepSeek Flash (VTID-04593 override) with
`maxTokens: 8000`. DeepSeek spends the budget on hidden reasoning and returns
empty `content` with `finish_reason: length`. `runProviderCall` reported that as
`ok:true` with empty text, so `callViaRouter` never tried the stage fallback
(Bedrock), and the planner failed on `call.ok && !call.text` without a reason.

## Fix

`llm-router.ts` `runProviderCall`: an ok result whose stop reason is a cap hit,
with no text and no tool call, becomes `ok:false` with the error
`<provider>/<model> returned no text: output cap reached (stop_reason=…, output_tokens=…)`
and an `llm.call.failed` record (`code: empty_truncated`). The existing fallback
logic then runs the stage fallback. A truncated reply that carries text or a
tool call is returned as before.

## Acceptance

AC-1 An empty reply cut off by the cap falls back to the stage fallback, which answers.
TEST: services/gateway/test/vtid-04794-router-empty-truncated-fallback.test.ts — "an empty reply cut off by the cap falls back to the stage fallback"

AC-2 With no fallback configured the call fails with a named reason, never ok with no text.
TEST: services/gateway/test/vtid-04794-router-empty-truncated-fallback.test.ts — "with no fallback configured it fails with a named reason"

AC-3 A truncated reply that has text, or carries a tool call, is unchanged.
TEST: services/gateway/test/vtid-04794-router-empty-truncated-fallback.test.ts — "a truncated reply WITH text" and "a truncated reply carrying a tool call"

AC-4 An empty reply that finished normally is unchanged.
TEST: services/gateway/test/vtid-04794-router-empty-truncated-fallback.test.ts — "an empty reply that finished normally is unchanged"

AC-5 The router, support and operator pipelines stay green.
TEST: services/gateway/test/llm-router.test.ts, test/vtid-03820-llm-router-override.test.ts, test/vtid-04546-llm-router-telemetry-nonblocking.test.ts, test/vtid-04456-customer-support-pipeline-regression.test.ts, test/vtid-04465-operator-pipeline-regression.test.ts

## Not covered here

- The live re-run of FB-2026-10-000144 happens after staging deploys this fix.
- The bridge reuses a finding's stale `proposed_files` and plan on every retry
  (separate follow-up).
