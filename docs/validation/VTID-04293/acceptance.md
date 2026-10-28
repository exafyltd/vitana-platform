# VTID-04293 — Acceptance

## Context (live staging, 2026-09-22, read-only)

After VTID-04280 (#3579, `3def809`) reached staging, previously planless
findings started getting plans and auto-approved executions. One of them,
impact finding `b560c306` ("new env var requires workflow binding"), was
approved three times: executions `257ba366` (21:03), `1164a32d` (21:09) and
`e4bcee32` (21:24). Each run is an agent run of ~1M DeepSeek tokens that
ends held at `awaiting_approval` — no PR, no merge, but pure waste and a
growing queue of identical diffs for a human to review.

Root cause: the partial unique index
`dev_autopilot_executions_finding_inflight_uniq` covers
`cooling,running,ci,merging,deploying,verifying` — not `awaiting_approval`.
The baseline pass of `autoApproveTick` checks `awaiting_approval` itself; the
IMPACT pass and the two manual approve routes do not, and
`approveAutoExecute()` had no in-flight check of its own. Once a held run
left `running`, the next impact tick approved the finding again. The gap
predates VTID-04280; VTID-04280 made it reachable by giving these findings
plans for the first time.

## Acceptance Criteria

AC-1: `approveAutoExecute()` refuses a finding that already has an execution in
cooling/running/awaiting_approval/ci/merging/deploying/verifying, before the
plan lookup and before any insert, naming the live execution and its status.
TEST: services/gateway/test/vtid-04293-approve-inflight-guard.test.ts — "refuses when the finding has an execution awaiting approval", "approveAutoExecute checks in-flight executions before loading the plan"

AC-2: A failed in-flight lookup refuses rather than approving blind.
TEST: services/gateway/test/vtid-04293-approve-inflight-guard.test.ts — "refuses when the lookup itself fails (never approve blind)"

AC-3: With nothing in flight the guard is transparent; the existing guards and
their fetch order are unchanged apart from the one added lookup.
TEST: services/gateway/test/vtid-04293-approve-inflight-guard.test.ts — "proceeds past the guard when nothing is in flight"; services/gateway/test/dev-autopilot-finding-completion.test.ts (fetch sequence updated by one lookup)

AC-4: The status list is shared and includes awaiting_approval.
TEST: services/gateway/test/vtid-04293-approve-inflight-guard.test.ts — "covers awaiting_approval and every status the unique index covers"

OASIS_IMPACT: no — no new event type; a refused approval surfaces through the
existing `auto-approve skipped` log line of each caller.

## Not done here, stated plainly

- The duplicate held executions already on staging (`1164a32d`, and
  `e4bcee32` once it finishes) are left for the owner to reject; this change
  only stops new ones.
- The executor ECS image still predates VTID-04280, so `runExecutionSession`
  inside the task keeps the old PR-flood guard and re-refused #3544/#3547/#3548
  after they were stamped. Rebuilding it (`AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml`)
  is an owner decision.
