# VTID-04497: the production gateway does not claim Dev Autopilot executions

`dev_autopilot_executions` is one table that two gateways read. An execution ends when its PR merges to `main`, and a push to `main` deploys **staging** only; production moves only through PUBLISH. The gateway that claims a row waits for a deploy event from its own environment (VTID-04215). So when production claims a row, it waits for a `prod.deploy.completed` that a merge never produces, the deploy watcher times out, and the merged PR is **reverted from `main`**.

Live evidence (read-only, `oasis_events` / `dev_autopilot_executions`):
- The production gateway claimed 352 of 524 executions in the last 3 days (`claimed_env=production`).
- 593cb4d1 was merged by production's watcher at 2026-09-22 21:21 (`45090ec`), then hit `Reconciler: 593cb4d1 stuck in deploying with no observed deploy event` and was reverted via #3585.
- 5769e66a was merged at 22:23 (`5414095`) and reverted via #3594 after `deploy failed`.
- b3d4f2b3 (VTID-04492, queued from the **staging** operator console on 2026-09-24 14:30) was claimed by production 206 ms after it became ready. It is held at `awaiting_approval` and deliberately not approved.
- By contrast, cdce6e55 was claimed by staging, merged by staging's watcher at 14:44:11 (#3667), and deployed by staging run 611.

## Acceptance criteria

AC-1 The staging gateway claims queued executions exactly as before.
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

AC-2 The production gateway claims nothing. Its tick still runs the watchdog, reconciler and archive passes for rows it already owns. It claims only when `DEV_AUTOPILOT_PROD_CLAIM_ENABLED` is exactly `true`.
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

AC-3 The gate filters by environment, never by lane. The VTID-04308 pin now requires that.
TEST: services/gateway/test/vtid-04308-feedback-approve-dispatch.test.ts

Mutation check: making `executorClaimsHere()` return `true` fails the AC-2 scenario (`expected "cooling"`).

## Takes effect only on a production promotion

The production gateway runs `64a53d3`. Merging this changes staging only, and staging already claimed. The behaviour that matters changes only when production is promoted, through PUBLISH or an approved pinned dispatch. That is the owner's decision.

OASIS_IMPACT: no new topics; one log line per process when the gate is closed.
