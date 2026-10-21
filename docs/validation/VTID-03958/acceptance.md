# VTID-03958 — Replace nova_canary_user_ids/tenant_ids with generic env_overrides input

## Report

`AWS-PROD-DEPLOY-GATEWAY.yml` — the only workflow that ever deploys the
production gateway (`vitana-gateway-awsdr`), `workflow_dispatch`-only — was
confirmed sitting at exactly GitHub's hard ceiling of 25 `workflow_dispatch`
inputs. A new production capability was requested (setting
`OPERATOR_EXECUTION_ONRAMP_ENABLED` on the prod task definition at dispatch
time); adding it as a 26th named input would have reproduced the exact
parse-failure incident VTID-03697's own header comment already documents
(GitHub refuses to parse the workflow at all past 25 inputs — not degraded,
totally undispatchable, including the Command Hub PUBLISH button).

Scope: `.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml` only. No runtime
gateway code changed. No AWS calls made, no workflow dispatched, PR not
merged.

## Acceptance Criteria

AC-1 — The workflow's declared `workflow_dispatch.inputs` count is reduced
from 25 to 24 (net: -2 retired, +1 added), so the file is safely under
GitHub's 25-input ceiling with one spare slot, and does not weaken the
existing guard test that enforces this.

TEST: `services/gateway/test/scripts/workflow-dispatch-input-limit.test.ts`
— parses every `.github/workflows/*.yml` with `js-yaml` and fails if any
file exceeds 25 `workflow_dispatch` inputs. Passes with the new 24-input
count for this file (see `commands.log`, "YAML / bash validation" section
and `outputs/tsc-and-guard-tests.txt`).

AC-2 — `nova_canary_user_ids` / `nova_canary_tenant_ids` are removed only
after confirming no real dispatcher of this workflow passes them, so no
caller silently loses a value it depended on.

TEST: manual grep + read of every dispatcher
(`services/gateway/src/routes/operator.ts`'s Command Hub PUBLISH handler
and its `AWS_DUAL_PUBLISH_ENABLED` leg, `scripts/deploy/publish-to-prod.sh`)
— recorded verbatim in `commands.log`, "Caller verification" section.
Neither caller ever set either input.

AC-3 — The new `env_overrides` input generically upserts ANY key/value
JSON object onto `.containerDefinitions[0].environment` (no hardcoded key
names), so `OPERATOR_EXECUTION_ONRAMP_ENABLED` (or any future one-off flag)
can be set at dispatch time with zero further workflow edits, while an
empty input is a true no-op and malformed/non-object JSON fails the step
loudly rather than silently no-op'ing or corrupting the task definition.

TEST: `services/gateway/test/vtid-03958-env-overrides-input.test.ts` (15
tests) extracts the real `env_overrides` jq block out of the workflow file
itself (not a reimplementation) and executes it against the real `jq`
binary with sample task-definition JSON — covering empty/no-op, add,
replace-existing, multi-key, non-string-value coercion, malformed JSON
(loud failure), and non-object JSON (loud failure). See
`outputs/tsc-and-guard-tests.txt` for the full pass/fail line and
`commands.log` for the exact command.

AC-4 — Adding `env_overrides` must not accidentally pin
`OPERATOR_EXECUTION_ONRAMP_ENABLED` into the workflow file itself — actually
promoting that specific flag to production stays a separate, deliberate,
later decision, per the pre-existing regression guard for exactly this.

TEST: `services/gateway/test/vtid-03820-onramp-staging-flag-pinned.test.ts`
(pre-existing, unmodified) — asserts the prod workflow file text does not
contain `OPERATOR_EXECUTION_ONRAMP_ENABLED`. An earlier draft of this PR put
that literal string in the new input's `description:` field and this test
caught it; the final version uses a generic `{"SOME_ENV_VAR":"value"}`
placeholder instead, and the test now passes. See `commands.log`, "Test
conflict found and resolved" section.

AC-5 — No regression to any other part of the gateway service from this
change (the diff is confined to one workflow file, one new test file, and
this evidence pack).

TEST: full gateway suite — 924/925 suites (1 pre-existing skip),
15,189/15,224 tests passing, 0 failures; `tsc --noEmit` clean. See
`outputs/tsc-and-guard-tests.txt` and `commands.log`.

## Explicitly not covered

No route is added or removed by this diff (it is a CI/CD workflow file, not
application code), so no `ROUTE_MOUNT:`/`FINAL_URL:`/`CURL_PROOF:` evidence
applies. No OASIS event emission is touched (`OASIS_IMPACT: no` in the PR
body). No AWS credentials were used and no `aws ecs`/workflow dispatch was
performed as part of this change — merging only affects what a future,
separate, deliberate `workflow_dispatch` of `AWS-PROD-DEPLOY-GATEWAY.yml`
can pass; it changes no running system by itself (merging to `main` auto-
deploys STAGING only, per this repo's staging-first governance, and this
file is prod-only and `workflow_dispatch`-only regardless).
