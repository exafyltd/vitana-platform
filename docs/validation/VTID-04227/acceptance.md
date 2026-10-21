# VTID-04227 — Declare the Dev Autopilot operating flags on `AWS-PROD-DEPLOY-GATEWAY.yml` (no dispatch)

## Reported

Platform owner, 2026-09-21: `DEV_AUTOPILOT_WATCHER_LIVE` is pinned only on
staging; `dev-autopilot-watcher.ts` defaults to DRY_RUN and the prod gateway
already synthesized fake `ci_passed`/`pr_merged` on a staging row (VTID-04003,
gap analysis §7). W0 (env ownership) stops cross-env claims, but prod still
runs its watcher in dry-run. Declare the five flags on the prod workflow with
pin tests; do NOT dispatch — the promotion is the owner's.

## Verified first (live task def `vitana-gateway-awsdr` rev 114, read-only)

| var | live prod value | live staging value (rev 489) |
|---|---|---|
| DEV_AUTOPILOT_WATCHER_LIVE | absent → DRY_RUN | `true` |
| DEV_AUTOPILOT_USE_JOB | absent → in-process | `true` |
| DEV_AUTOPILOT_JOB_CLOUD | `aws` | `aws` |
| DEV_AUTOPILOT_LLM_REVIEW_ENABLED | absent → off | `true` |
| DEV_AUTOPILOT_EXECUTOR_ENABLED | `false` (VTID-03579 breaker) | absent → on (`!== 'false'`) |

`dev-autopilot-watcher.ts:48-51`: `DRY_RUN` is false only when
`DEV_AUTOPILOT_WATCHER_LIVE === 'true'`; otherwise `DEV_AUTOPILOT_DRY_RUN || 'true'`.

## What changed

One unconditional strip-then-add block in step 1/2 of
`AWS-PROD-DEPLOY-GATEWAY.yml` (after the VTID-04098 feature-flag pins):
`DEV_AUTOPILOT_WATCHER_LIVE=true`, `DEV_AUTOPILOT_USE_JOB=true`,
`DEV_AUTOPILOT_JOB_CLOUD=aws`, `DEV_AUTOPILOT_LLM_REVIEW_ENABLED=true`,
`DEV_AUTOPILOT_EXECUTOR_ENABLED=true`. The existing per-dispatch
`dev_autopilot_executor_enabled` input (step 2/2) runs AFTER the block and
still wins for that one dispatch. Both prod run: steps stay under the
VTID-03788 20,000-char guard (16,992 / 15,291).

`vtid-03850-staging-executor-dispatch-pinned.test.ts`'s "deliberately NOT
pinned on prod" assertion is inverted to "now also declared on prod".

## Read before dispatching (owner decision, IF-THEN 26)

- The live value `DEV_AUTOPILOT_EXECUTOR_ENABLED=false` is the VTID-03579
  circuit breaker (990 planner calls/day on 2026-08-11). The first prod
  dispatch after this merges turns the executor ON unless
  `dev_autopilot_executor_enabled=false` is passed. The root cause of that
  storm (lazyPlanTick re-planning without a plan row) was fixed; the DB gate
  `dev_autopilot_config.auto_approve_enabled` is currently `false`, so even
  with the executor on, nothing auto-approves until that row is flipped.
- `DEV_AUTOPILOT_USE_JOB=true` needs `ecs:RunTask`/`iam:PassRole` on the
  gateway task role — the same `vitana-ecs-task-role` staging runs on (both
  task defs share it; VTID-04037 proved the dispatch on staging).
- Prod also still lacks `DEV_AUTOPILOT_SCAN_TOKEN` and
  `GATEWAY_INTERNAL_TOKEN` (deliberately not added here — VTID-04225/04226
  wire them on staging only); a prod scan/scheduler promotion needs both.

## Acceptance criteria

AC-1 The five flags are pinned unconditionally on the prod workflow, each stripped before being re-added.
TEST: services/gateway/test/vtid-04227-prod-dev-autopilot-flags-pinned.test.ts — "pins … unconditionally" / "strips any inherited …"

AC-2 The per-dispatch executor circuit breaker still runs after the declaration and wins for that dispatch.
TEST: services/gateway/test/vtid-04227-prod-dev-autopilot-flags-pinned.test.ts — "the per-dispatch circuit breaker … still runs AFTER"

AC-3 Prod and staging agree on the values; `gcp` is never pinned; the workflow stays workflow_dispatch-only.
TEST: services/gateway/test/vtid-04227-prod-dev-autopilot-flags-pinned.test.ts — "prod and staging now agree" / "never pins the gcp job cloud" / "is still workflow_dispatch-only"

AC-4 The prod workflow still parses, passes `bash -n`, and stays under the run-block size guard.
TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts

AC-5 The prod workflow was NOT dispatched by this session.
TEST: services/gateway/test/vtid-04227-prod-dev-autopilot-flags-pinned.test.ts — "is still workflow_dispatch-only — declaring is not deploying" (and `outputs/no-dispatch.txt`)
