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


---

## Live results (2026-09-18, staging on a4d68be / task def vitana-gateway:419)

| AC | Result |
|---|---|
| AC-1..AC-5 | PASS — automated, at merge of #3410 |
| AC-6 | **PASS** — `/api/v1/admin/health` `env=staging`; build-info `a4d68be5ad2d…` booted 07:31:15Z; task def **vitana-gateway:419** carries `OPERATOR_VTID_SELF_ALLOCATE_ENABLED`, `OPERATOR_PR_APPROVAL_REQUIRED`, `OPERATOR_THREADS_ENABLED`, `OPERATOR_TURN_MEMORY_ENABLED` = `true`, and no `OPERATOR_SQL_READONLY_*` (the secret is not provisioned, so the optional wiring correctly did nothing) |
| AC-7 | **PASS** — `POST /operator/chat/stream` framed `turn.started → model.turn → tool.call → tool.result → model.turn → reply → done`; reply meta carried `cost_usd`, `cost_priced`, `usage`, `model_calls`, `duration_ms` on DeepSeek Flash |
| AC-8 | **PASS** — Run #5 + #7, end to end: open-ended request → VTID-04038 self-allocated → agent executor → `awaiting_approval` (5 files, no PR) → `autopilot_review_execution` from chat → `autopilot_approve_execution` from chat → PR #3412 → 18/18 green → merged `0db8047`. Cancel leg: VTID-04040 queued and cancelled from chat while `running`; StopTask IAM denial returned verbatim; the agent stopped cooperatively and its task exited on its own; nothing pushed |
| AC-9 | **NOT VERIFIED** — fix mode never ran, because no agent PR reached CI. Run #6 died on a read_file defect (VTID-04042, fixed); Run #6b on the rebuilt image cleared that and still hit the 60-turn cap, 6 turns of which were date hunts (VTID-04046, fixed). See `outputs/run-6.md` |
| AC-10 | **PASS (as designed)** — `dev_cloudwatch_logs` / `dev_ecs_tasks` / `ecs:StopTask` return the IAM denial verbatim rather than failing silently; `dev_run_sql_readonly` reports `not_configured`. Both owner scripts are shipped and unrun |

### Defects this pass found, all fixed and merged the same day

| VTID | PR | What it was |
|---|---|---|
| VTID-04042 | #3414 | `read_file`/`search_text` refused any file over 2 MB before honouring `start_line`/`end_line`, so the Command Hub bundle was unreadable in every range |
| VTID-04043 | #3415 | The verification window counted a sibling execution's `vtid.lifecycle.failed` as production blast radius, failing VTID-04038 with its PR green |
| VTID-04046 | #3416 | The agent prompt carried no date, so dated tasks made it search the repo for one |

### Still owner-gated (unchanged by this pass)

- `scripts/aws/setup-operator-agent-task-role-grants.sh --apply` — the session user's permissions boundary explicitly denies `iam:*` on `vitana-ecs-task-role`.
- `scripts/aws/setup-operator-sql-readonly-secret.sh --apply` — secret values are withheld from sessions; one more staging deploy then wires SQL automatically.
