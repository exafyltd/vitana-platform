# VTID-04363 — Acceptance

## Context

Staging and production are two gateways over one `dev_autopilot_executions`
table, and both ran the Dev Autopilot background loop (claim, auto-approve,
lazy plan, reapers). A merge to `main` deploys staging only, so an execution
the production gateway claimed never sees a deploy event for its merge commit
and the reconciler reverts it 30 minutes after merging. The owner armed the
kill switch to stop this (VTID-04346); this change removes the cause so the
switch can be disarmed.

## Acceptance Criteria

AC-1: The loop owner resolves to `staging` unless `DEV_AUTOPILOT_LOOP_OWNER_ENV` is exactly `production`; exactly one environment is active for any setting.
TEST: services/gateway/test/vtid-04363-autopilot-loop-owner.test.ts — "defaults to staging — the environment a merge to main deploys", "moves to production only on the exact value", "exactly one environment is active for every setting"

AC-2: `startBackgroundExecutor` returns before starting any tick on a non-owner gateway.
TEST: services/gateway/test/vtid-04363-autopilot-loop-owner.test.ts — "returns before any setInterval when this gateway is not the owner"

AC-3: The supervisor snapshot reports `loop` and raises an info alert on the gateway that does not run the loop, and none on the owner.
TEST: services/gateway/test/vtid-04363-autopilot-loop-owner.test.ts — "says so on the gateway that does not run the loop", "stays quiet on the owner"

AC-4: The staging task def declares `VITANA_ENV=staging` (it was live-state only; losing it would stop the loop everywhere).
TEST: services/gateway/test/vtid-04363-autopilot-loop-owner.test.ts — "declares VITANA_ENV=staging and strips any earlier value"

AC-5 (post-deploy, live): staging logs `starting background executor`; production (after its next promotion) logs `background loop NOT started: env=production, loop owner=staging`; new `dev_autopilot_executions` claims carry `claimed_env=staging` only.
CURL: curl -s https://gateway.vitanaland.com/api/v1/dev-autopilot/supervisor
