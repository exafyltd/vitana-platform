# VTID-04037 — Operator agent staging enablement (steps 1-4 of the plan, owner-approved)

Owner instruction, verbatim, 2026-09-18: "Ok, let's go and finish 1-4 in one to finish all of it" —
the four steps named in the readiness assessment: (1) rebuild the executor image, (2) pin the
four owner-gated flags on staging, (3) the IAM grants + Aurora read-only role, (4) the live
verification pass (streaming turn, Runs #5, #6, #7).

## What this PR does

| Step | Outcome | Evidence |
|---|---|---|
| 1 | `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` run 13 dispatched from `main` `7c8c600` (W5c) — image now carries W4e hold-for-approval and W4h cooperative cancel; the previous image (run 12) was from `3c9c6d0` (W3). Completed success 07:03 UTC. | `outputs/executor-rebuild.txt` |
| 2 | `AWS-STAGE-DEPLOY-GATEWAY.yml` pins `OPERATOR_VTID_SELF_ALLOCATE_ENABLED`, `OPERATOR_PR_APPROVAL_REQUIRED`, `OPERATOR_THREADS_ENABLED`, `OPERATOR_TURN_MEMORY_ENABLED` to exact `"true"` (strip-then-add, staging only); read-only SQL wired the optional ERP-bridge way (present secret → enabled + URL as a task-def secret; absent → untouched, never `exit 1`). | `services/gateway/test/vtid-04037-staging-operator-agent-flags-pinned.test.ts` |
| 3 | Two owner-run scripts, because this session cannot write IAM or read secret values (both refused by the harness classifier — recorded in commands.log): `scripts/aws/setup-operator-agent-task-role-grants.sh` (logs:FilterLogEvents/DescribeLogGroups on `/ecs/vitana-*`, ecs:ListTasks/DescribeTasks on the cluster, ecs:StopTask on its tasks — one inline least-privilege policy) and `scripts/aws/setup-operator-sql-readonly-secret.sh` (composes the read-only URL from the existing `claude_readonly` Data-API credential + the Aurora reader endpoint into `vitana/gateway/staging/operator-sql-readonly-url`). | dry runs in commands.log |
| 4 | Runs after this merges and staging redeploys — recorded in `outputs/` and the CLAUDE.md row as they happen. | `outputs/run-*.md` |

## Acceptance criteria

AC-1 — the four flags are pinned to exact `"true"` on staging and stripped first.
TEST: services/gateway/test/vtid-04037-staging-operator-agent-flags-pinned.test.ts

AC-2 — the prod deploy workflow carries none of the flags nor the SQL wiring.
TEST: services/gateway/test/vtid-04037-staging-operator-agent-flags-pinned.test.ts

AC-3 — the SQL secret is optional: outside the hard-fail loop, absent means not wired, never a failed deploy.
TEST: services/gateway/test/vtid-04037-staging-operator-agent-flags-pinned.test.ts

AC-4 — every pinned flag is read by its module with the exact-string check.
TEST: services/gateway/test/vtid-04037-staging-operator-agent-flags-pinned.test.ts

AC-5 — every `run:` step of both gateway deploy workflows still parses under `bash -n` and stays under the size cap.
TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts

AC-6 — (live, post-merge) staging serves this commit; `/api/v1/admin/health` reports env=staging.
CURL: GET https://preview-aws-gateway.vitanaland.com/api/v1/admin/build-info — recorded in outputs/ after the deploy

AC-7 — (live) a streaming console turn returns `turn.started … reply … done` frames with `cost_usd` on the reply meta (W4d, W4g).
CURL: POST https://preview-aws-gateway.vitanaland.com/api/v1/operator/chat/stream — recorded in outputs/run-ac7-stream.md

AC-8 — (live, Run #5 + #7) an open-ended `autopilot_run_task` request allocates a VTID, runs on the agent executor, holds as `awaiting_approval`, is reviewed and approved from chat, opens a PR; a second execution is cancelled from chat.
CURL: POST https://preview-aws-gateway.vitanaland.com/api/v1/operator/chat/stream — recorded in outputs/run-5.md

AC-9 — (live, Run #6) a CI-failing agent PR is continued in fix mode on the same branch, no second PR.
CURL: POST https://preview-aws-gateway.vitanaland.com/api/v1/operator/chat/stream — recorded in outputs/run-6.md

AC-10 — (live) `dev_cloudwatch_logs` / `dev_ecs_tasks` return data once the owner applies the grant script; until then they return the IAM denial verbatim.
CURL: POST https://preview-aws-gateway.vitanaland.com/api/v1/operator/chat/stream — recorded in outputs/ when exercised

## Not done here, named

- The IAM policy is NOT applied — `iam:PutRolePolicy` on `vitana-ecs-task-role` is explicitly denied by the session user's permissions boundary and the harness classifier refused the write. Owner runs the script (`--apply`).
- The SQL URL secret is NOT created — reading the source secret value is withheld from this session. Owner runs the script (`--apply`); the next staging deploy then wires it automatically.
- Production: untouched (`AWS-PROD-DEPLOY-GATEWAY.yml` carries none of this).
