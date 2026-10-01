# VTID-04324 — stop the ungoverned July-9 ECS services (Orchestrator plan §8.1)

Owner decision 2026-09-23: "You decide". Decision taken: scale to zero, keep
the services and task definitions for a 14-day rollback window, then delete
in a separate VTID. Rationale and evidence: 21 of the 23 have logged nothing
for 12+ days, none has an ALB target group or Cloud Map entry (nothing can
call them), and every one injects the production DB password and Supabase
service-role key. Scale-to-zero stops every running copy of those
credentials and is reversed by one dispatch with `desired_count: 1`.

This session's own identity cannot call `ecs:UpdateService` (verbatim
denial in commands.log), and ALWAYS 17 requires ECS state changes to go
through CI anyway — hence a dispatch-only workflow on the prod OIDC role.

## Acceptance criteria

AC-1: The workflow can only act on the 23 orphans and the retired
vitana-worker-runner; any other name (every serving/governed service) is
refused before an AWS role is assumed.
TEST: services/gateway/test/vtid-04324-ecs-scale-allowlist.test.ts

AC-2: The workflow is workflow_dispatch only, requires a reason, and
defaults to a dry run.
TEST: services/gateway/test/vtid-04324-ecs-scale-allowlist.test.ts

AC-3: The workflow authenticates with GitHub OIDC (no static keys) and
refuses any account other than 472838866351.
TEST: services/gateway/test/vtid-04324-ecs-scale-allowlist.test.ts

AC-4 (post-merge, live): a dispatch with `dry_run=false, desired_count=0,
services=all` leaves all 24 at desiredCount 0 / runningCount 0, and no
other service changes. Recorded in outputs/ecs-state-after.txt.
TEST: services/gateway/test/vtid-04324-ecs-scale-allowlist.test.ts (allowlist); live evidence in outputs/

## Not done here (owner actions, named)

- Rotating `vitana/supabase/prod/service-role-key`: every one of these task
  definitions carried it; once they are stopped, rotation is the only thing
  that revokes copies already read. Rotation touches every real consumer
  (gateway task defs, edge functions), so it is its own planned change.
- Deleting the services / deregistering task definitions after the window.
