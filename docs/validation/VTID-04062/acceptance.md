# VTID-04062 — re-pin the VTID-03850 executor strip-list test after VTID-04050

## Report

VTID-04050 (#3420, merged as `a45cfd0c`) added `AGENT_MAX_TURNS`/
`AGENT_DEADLINE_MS` to the jq strip-list in
`AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml`'s register-task-definition step,
but the PR that landed it never updated
`test/vtid-03850-staging-executor-dispatch-pinned.test.ts`'s pinned
regex asserting that exact strip-list. This broke the Gateway (Jest)
check on every PR based on `main` since that merge, independent of what
each PR itself changes — first observed on PR #3421, an unrelated Command
Hub ownership-guard change.

This VTID is the fix; VTID-03850 itself is the original, already-shipped,
terminal feature the test file is named after and is untouched by this
change (its own evidence pack under `docs/validation/VTID-03850/` is
historical record and is not modified here).

## Acceptance Criteria

AC-1 — The strip-list regression test matches the real four-name
`IN("BEDROCK_ROLE_ARN","AWS_BEDROCK_REGION","AGENT_MAX_TURNS","AGENT_DEADLINE_MS")`
strip-list in `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml`.
TEST: services/gateway/test/vtid-03850-staging-executor-dispatch-pinned.test.ts — `npx jest services/gateway/test/vtid-03850-staging-executor-dispatch-pinned.test.ts`

AC-2 — A new assertion pins the two new env values (`AGENT_MAX_TURNS=120`,
`AGENT_DEADLINE_MS=2100000`) directly.
TEST: services/gateway/test/vtid-03850-staging-executor-dispatch-pinned.test.ts — same suite, new `it('sets AGENT_MAX_TURNS/AGENT_DEADLINE_MS ...')` case.

OASIS_IMPACT: no — test-only change, no runtime code or OASIS event surface touched.
