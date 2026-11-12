# VTID-05023 agent K: runbook drill

Scope: walk the window runbook against the rehearsal, as far as the rehearsal allows. Read-only checks only. No production step was run. Nothing was written to the rehearsal clone.

## Inputs

- Runbook: `docs/validation/VTID-05023/window-runbook.md` on `origin/cutover/vtid-05023-D-window-runbook` (pushed; the runbook states its base commit is `a02b8918f3`).
- Base: `origin/main` = `a02b8918f38a57f7b0b6910a365e2a70629d6b89`.
- Migration list: not used. Branch `cutover/vtid-05023-G-migration-inventory` is not on the remote, so `migration-order.md` does not exist yet.
- REST setting (agent C): not used. No C branch on the remote, and no REST base setting on `main`.
- Gate (agent A): gate line exists on `main` (`infra/gitlab-engineering/ci/staging-gateway-deploy.gitlab-ci.yml`, line 79). Staging gate status not read. Lane records 12 failing gate tests with fixes on unmerged branches.

## Rehearsal state (read-only AWS)

| Check | Result |
|---|---|
| `aws sts get-caller-identity` | `472838866351`, matches handover V1 |
| `aws rds describe-db-clusters --db-cluster-identifier vitana-aurora-rehearsal` in us-east-1 | `AccessDenied`: `User: arn:aws:sts::472838866351:assumed-role/kiro-1-dstevanovic/... is not authorized to perform: rds:DescribeDBClusters on resource: arn:aws:rds:us-east-1:472838866351:cluster:vitana-aurora-rehearsal` |
| Same call in eu-central-1 (region in handover §1) | `AccessDenied`, same action, resource `...eu-central-1...:cluster:vitana-aurora-rehearsal` |
| List all clusters, eu-central-1 and us-east-1 | `AccessDenied`, resource `cluster:*` |

Result: the rehearsal clone's existence, status, Data API flag and `rds.logical_replication` value (handover V2) cannot be confirmed from this session.

## Step table

Mark key: RUNNABLE NOW = read-only and runnable here. OWNER-ONLY = production step, or marked owner command required. BLOCKED = cannot run, reason and missing item given.

| Step | Step | Mark | Reason | Prerequisite still missing |
|---|---|---|---|---|
| Pre-1 | Account check (`aws sts get-caller-identity`) | RUNNABLE NOW | Ran. Returns `472838866351`. | None |
| Pre-2 | Staging gate green on one commit (`$DEPLOYED_COMMIT`) | BLOCKED | Lane records 12 failing gate tests (A1). Fixes are on unmerged branches. Gate status not read in this drill. | A1 fixes merged, STAGING-VERIFY green on one SHA |
| Pre-3 | `verify-cutover.sh` readable on `gitlab-migration-prep` | BLOCKED | Branch absent from remote heads. Script absent from `origin/main` and from every `cutover/*` branch checked. | Branch or path of `scripts/cutover/verify-cutover.sh` (T2) |
| Pre-4 | Migration list confirmed (O5) | BLOCKED | `cutover/vtid-05023-G-migration-inventory` not on remote. `migration-order.md` absent. | Push G branch; owner confirms O5 |
| Pre-5 | Production Aurora parameter change and reboot | OWNER-ONLY | Production cluster `vitana-aurora-prod` and reboot. `aurora-cluster-params-cutover.sh` exists on main, dry-run by default. | Exact production invocation and reboot command (T1). The rehearsal value is also unknown (AccessDenied). |
| Pre-6 | Port 4000 security-group rule `sg-0fbcf7b59b1f0d685` | OWNER-ONLY | Network change (O3). Only needed if Realtime moves. | Owner decision on Realtime; command not in runbook |
| Pre-7 | `aws dms test-connection` on both reverse endpoints | OWNER-ONLY | Endpoints are production-side. Not identified in the repo, and DMS describe is not permitted here. | Endpoint identifiers; owner runs the test |
| Pre-8 | `$GATEWAY_BASE_URL` for production | BLOCKED | Value not in runbook or repo. | Production gateway URL (T15) |
| 1a | GitHub freeze (`MIGRATION_FREEZE`) | OWNER-ONLY | Production merge freeze. No command in repo. Conflicts with step 3, which needs `MIGRATION_FREEZE` off. | Freeze command (T3); decision on how step 3 passes the freeze |
| 1b | Supabase write freeze (`aurora-cutover-freeze-writes.sql`) | OWNER-ONLY | Writes to Supabase production. Script present on main. Header date and VTID are stale per the runbook. | psql invocation and Supabase URL from masked variable (T4) |
| 1c | Unschedule Supabase cron; disable triggers | OWNER-ONLY | Supabase production. Both scripts present on main. | psql invocations (T5) |
| 2a | Final DMS load (`aurora-cutover-final-catchup-task.sh`) | OWNER-ONLY | Starts a production DMS task. Script present on main. | Start command and `$DMS_FINAL_TASK_ARN` (T6) |
| 2b | After-load SQL on production Aurora | OWNER-ONLY | Production writes. The three SQL files are on main. Wrapper `aurora-cutover-after-load.sh` is hard-wired to production, so it cannot be pointed at the rehearsal. | Invocation for production (T7). Rehearsal-target variant is not defined. |
| 2c | Embedding backfill | OWNER-ONLY | Production writes. Script present on main. | Arguments and target (T8) |
| 2d | Privilege parity gate (`aurora-privilege-parity.py --check --strict`) | OWNER-ONLY | Runbook names `vitana-aurora-prod`, even in `--check` mode. Needs `$SUPABASE_SNAPSHOT_JSON` and `$AURORA_OWNER_ROLE`. The same script against the rehearsal is the rehearsal analogue, but it needs cluster access that is denied here. | Snapshot JSON, owner role name, rehearsal cluster read access |
| 2e | Verify final sync (`verify-cutover.sh`) | BLOCKED | Script not found on main or on any checked branch (see Pre-3). | Script location and invocation (T2, T9) |
| 2f | Start storage-auth CDC task | OWNER-ONLY | Starts a production DMS task. | Start command and ARNs (T10) |
| 3 | Migrations, one file per run, in order | BLOCKED | Ordered list absent (G branch not pushed). `RUN-MIGRATION.yml` on main refuses while `MIGRATION_FREEZE=true`. Placement of `aurora-pgrst-ddl-watch.sql` unknown. Held drop excluded. | Migration list (O5, T11); freeze conflict decision; placement of DDL watch (T12) |
| 4a | Production gateway to Aurora proxy (`AWS-PROD-DEPLOY-GATEWAY.yml`) | OWNER-ONLY | Production deploy. Workflow on main. `env-only` does not pin the verified commit, which the handover requires. | Deploy mode choice; pinned commit `$DEPLOYED_COMMIT`; freeze decision |
| 4b | REST base setting (`DATA_REST_URL` prod; `DATA_REST_BASE_MODE`) | BLOCKED | Agent C setting absent. No REST setting in `services/gateway/src` on main. No C branch on remote. Runbook names two different settings. | Agent C MR merged; decision on which setting controls REST (T13) |
| 4c | Other services (verification-engine, orb-agent, autopilot-executor) | OWNER-ONLY | Workflows exist on main: `AWS-PROD-DEPLOY-VERIFICATION-ENGINE.yml`, `AWS-PROD-DEPLOY-ORB-AGENT.yml`, `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml`. Production deploys. | `commit_sha` for each; order after gateway confirmed (T14) |
| 5a | `/alive` on production gateway | OWNER-ONLY | Production URL. | `$GATEWAY_BASE_URL` (T15) |
| 5b | Build-info matches `$DEPLOYED_COMMIT` | OWNER-ONLY | Production URL. `admin-health.ts` present on main. | `$GATEWAY_BASE_URL`; pinned commit |
| 5c | One `/rest/v1` read | OWNER-ONLY | Production read through `data.vitanaland.com`. Runbook says "through the gateway" and the handover says `data.vitanaland.com`. | `$SAMPLE_TABLE`, `$SAMPLE_COLUMN`, key source (T16); path confirmation |
| 6 | Two-hour watch | OWNER-ONLY | Production monitoring. No dashboards or CLI commands in repo. | Dashboard names, log groups, commands, cadence (T17) |
| 7a | Switch REST back to Supabase | OWNER-ONLY | Production. `gh variable delete DATA_REST_URL` is written. `DATA_REST_BASE_MODE` command missing. | Agent C setting merged; rollback command (T18) |
| 7b | Gateway to previous revision on Supabase | OWNER-ONLY | Production. Workflow on main. Revision not pinned. Other services' pins missing. | Revision pin (T19); other services' workflow inputs (T20) |
| 7c | Stop DMS; trigger rollback; unschedule rollback | OWNER-ONLY | Production DMS and Supabase. Rollback scripts present on main. | Stop commands and ARNs (T21); psql invocations (T22) |

Rehearsal drill result: no runbook step could be run against `vitana-aurora-rehearsal`. The runbook has no rehearsal target parameters. The clone cannot be described from this session, so its state is unknown.

## Discrepancies

1. Region. Handover §1 says eu-central-1. The sandbox CLI defaults to us-east-1. Both were denied, so the owner should confirm the region.
2. Repo path. The handover names `exafyltd/vitana-platform`. This run uses GitLab `vitana/vitana-platform`.
3. Runbook "Before step 1" item 2 reported a 404 for `gitlab-migration-prep`. Confirmed: the branch is not on the remote.

## Owner commands still needed

These are the runbook TODO items (T1 to T22), plus the following items the drill added:

- Push `cutover/vtid-05023-G-migration-inventory` so the migration list exists (Pre-4).
- Provide the `gitlab-migration-prep` branch or the `verify-cutover.sh` path (Pre-3, 2e).
- Grant `rds:DescribeDBClusters` for `vitana-aurora-rehearsal`, or confirm the region, to unblock the rehearsal state check.
- Merge agent C's REST setting MR and confirm which setting name controls REST (4b, 7a).
- Decide how step 3 passes `MIGRATION_FREEZE=true` (1a).

## Security note

During this drill, one diagnostic command printed the process environment into the session output. That output included `GITLAB_TOKEN`, `ACCESS_TOKEN`, `GATEWAY_SERVICE_TOKEN`, and an AWS container authorization token. None of these were written to this file or to git. Rotate them.
