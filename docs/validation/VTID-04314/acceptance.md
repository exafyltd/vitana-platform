# VTID-04314 — Acceptance

## Context (read-only, 2026-09-22/23)

Every `AWS-STAGE-DEPLOY-GATEWAY.yml` run since 2026-09-22 22:21 UTC (runs 544,
546, 548, 549, 550, 551; 545/547 cancelled) failed in "Register task-definition
revision + roll the service" with `aws: [ERROR]: Waiter ServicesStable failed:
Max attempts exceeded`. Staging kept serving `e09eb26` (booted 22:02:04 UTC).

Run 543 (green, `e09eb26`) and run 550 (red, `7763609`) produce identical
build output (including the long-standing non-fatal RepoWise pip
ResolutionImpossible) and identical secret-resolution lines; the only
difference is the rollout outcome. The first failing commit (`cfff04a`) adds
a test file and docs only. The cause therefore lives in the running tasks,
which the job log never shows. It also blocks the approved production
promotion: the `promote-staging` preflight refuses while the staging task def
and the served commit disagree.

## Acceptance Criteria

AC-1: The roll step has `id: roll`, and a new step runs only when it failed.
TEST: services/gateway/test/vtid-04314-staging-rollout-diagnostics.test.ts — "gives the roll step an id the diagnostic step can key off", "runs only when the roll step failed"

AC-2: The step prints the deployments (rollout state + reason), the latest 15
service events and the stop code/reason/exit code of recent stopped tasks.
TEST: services/gateway/test/vtid-04314-staging-rollout-diagnostics.test.ts — "prints deployments, service events and stopped-task reasons"

AC-3: The step is read-only and never fails the job on its own.
TEST: services/gateway/test/vtid-04314-staging-rollout-diagnostics.test.ts — "never fails the job on its own and never mutates ECS"

AC-4: Every run: step still passes `bash -n` and the size cap.
TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts

AC-5 (post-merge, live): the staging deploy for this merge either goes green,
or its log names the rollout failure in the new step.
