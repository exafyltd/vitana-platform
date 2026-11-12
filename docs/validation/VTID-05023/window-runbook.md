# VTID-05023 cutover window runbook (option B: /rest/v1 on Aurora)

Status: readiness pack. Nothing in this file has been run. Every production step is an owner command. Kiro does not execute any step here.

Base commit read: `origin/main` at `a02b8918f38a57f7b0b6910a365e2a70629d6b89`.

## Scope

Option B moves the `/rest/v1` data path to Aurora through the PostgREST-Aurora proxy (`postgrest-aurora-prod.vitana.internal:8080`; public `data.vitanaland.com` serves `/rest/v1` and `/alive`). Auth, Storage, Edge Functions and the chat and voucher storage policies stay on Supabase. A full Supabase exit is out of scope (handover §1, Option B scope).

Sources:
- Handover: `docs/handover/VTID-05023/KIRO-HANDOVER.md` on branch `cutover/vtid-05023-handover`, Part 4 (production window outline) and Part 5 (owner steps O1 to O6).
- `docs/validation/VTID-05023/other-services.md`, "Window" section (gateway first, then `DATA_REST_URL`, then verification-engine, orb-agent and autopilot-executor; rollback order).
- `docs/validation/VTID-05023/storage-auth.md`, "Window order" and rollback order.
- `docs/validation/VTID-05023/plan-sparring.md`, parts 11 and 12.
- `docs/validation/VTID-05023/rehearsal.md`, sections G and J (rehearsal steps and read-path watch thresholds).

## Conventions

- `owner command required` marks every step that touches production, Supabase production or the production Aurora cluster `vitana-aurora-prod`.
- Placeholders use `$NAME` form. Secret values, keys and connection strings are never written here. Secret ARNs are passed by name, for example `$SECRET_ARN`, read from the masked GitLab or GitHub variables named in the handover.
- A step marked `TODO: owner to supply` has no command in the handover or in the repo. The list of these is in the last section.
- `$REPO` means `exafyltd/vitana-platform`.

## Before step 1 (owner checks)

These are preconditions taken from the handover. Each one must be true before the window opens.

1. The staging gate is green on one commit (handover §9.2). Record the commit SHA as `$DEPLOYED_COMMIT`.
2. `scripts/cutover/verify-cutover.sh` is readable on branch `gitlab-migration-prep` (handover §6 G1). On the check made for this runbook, the GitLab API returned `404 Commit Not Found` for that branch in project 2. The script's location or branch must be confirmed before the window.
3. The migration list is confirmed by the owner (handover §5, O5). The list lives in `docs/validation/VTID-05023/migration-order.md`, which agent G produces on its own branch. It is not on `main` yet. This list is pending the owner confirmation O5.
4. Production Aurora parameter change and reboot are done (handover §4). `rds.logical_replication=1` is needed for the DMS CDC tasks (storage-auth.md, Prerequisites). The script `scripts/aws/aurora-cluster-params-cutover.sh` is dry-run by default and needs `--apply`.
   - Owner command required: `TODO: owner to supply` (the exact invocation for production, parameter group `vitana-aurora-pg17-prod`, cluster `vitana-aurora-prod`, and the reboot command).
5. Port 4000 security-group rule `sg-0fbcf7b59b1f0d685` is in place (handover §5, O3), if Realtime moves in this window. Realtime is an owner decision (plan-sparring 7a and 7b) and is listed under "Not in this window" as well.
6. `aws dms test-connection` passed on both reverse endpoints (storage-auth.md, Prerequisites).
7. The gateway URL for production health checks is known: `$GATEWAY_BASE_URL`. `TODO: owner to supply` (not in the handover or the repo).
8. Account check: `aws sts get-caller-identity` returns `472838866351` (handover §2, V1). Every AWS call in the window runs this check first.

## Step 1. Freeze writes

Goal: nothing writes to Supabase `public` once the freeze is in place. The GitHub freeze and the Supabase database freeze are two separate actions.

1a. GitHub freeze. Stop merges and migration dispatches.
- The named switch is the repository variable `MIGRATION_FREEZE` (handover §1; `iam-request.md`). `RUN-MIGRATION.yml` refuses to run when `MIGRATION_FREEZE=true` (`outputs/aurora-migrations.txt`).
- rehearsal.md, section G step 0 freezes merges that touch `services/gateway/**` and `services/postgrest-aurora-proxy/**` for the rehearsal. The handover does not say whether production uses the same freeze. The owner decides.
- Owner command required: `TODO: owner to supply`. The handover names the freeze but gives no command for it. The variable name is `MIGRATION_FREEZE`. The merge-freeze mechanism (branch protection or a merge hold) is not defined in the repo.
- Conflict: step 3 dispatches `RUN-MIGRATION.yml` while the freeze is active. The owner must decide how step 3 gets past `MIGRATION_FREEZE=true`. See the open items.

1b. Supabase database write freeze. Source: `scripts/aws/aurora-cutover-freeze-writes.sql` (run against Supabase, not Aurora).
- The script revokes INSERT, UPDATE and DELETE from `anon`, `authenticated` and `service_role`. Reads are unchanged.
- Its header names the 2026-09-20 window and VTID-04084. It must be checked before reuse.
- plan-sparring F3 says a role REVOKE alone does not stop writes from `pg_cron` jobs or `SECURITY DEFINER` functions. The unschedule and trigger steps below cover that gap.
- Owner command required: `TODO: owner to supply` (the psql invocation, with the Supabase database URL from the masked GitLab variable, never from a file).

1c. Unschedule Supabase cron and disable Supabase triggers.
- `scripts/aws/supabase-cutover-unschedule.sql` (storage-auth.md, Window order 1).
- `scripts/aws/supabase-cutover-reverse-cdc-triggers.sql` (storage-auth.md, Window order 2). It snapshots and disables the 239 user triggers on 152 `public` tables, with FK triggers left on.
- Owner command required: `TODO: owner to supply` (the psql invocation for each file against the Supabase project).

## Step 2. Final copy

The handover says "Aurora final copy" and "DMS start" (handover §4). It names no `pg_dump` snapshot. The rehearsal used DMS full load plus the storage-auth CDC scope, and parity was checked from one fixed snapshot (handover C4, C7).

The brief for this runbook named "pg_dump snapshot plus the storage-auth DMS scope" as the rehearsal method. That wording does not appear in the handover or the VTID-05023 docs. This runbook follows the handover. Owner must confirm the final-copy method before the window. See the open items.

2a. Final DMS load. Repo files:
- `scripts/aws/aurora-cutover-final-catchup-task.sh`. It is the final load task, with the 10 `exclude-done-*` mapping rules removed, and it uses `TRUNCATE_BEFORE_LOAD`.
- Owner command required: `TODO: owner to supply` (the start command and the production task ARN `$DMS_FINAL_TASK_ARN`). The handover says the DMS task starts in the window. It names no command. `aurora-to-supabase-cdc.sh` creates tasks and does not start them (C7).

2b. After-load steps on production Aurora, in order (rehearsal.md, section G step 4, names the files; the wrapper `aurora-cutover-after-load.sh` is hard-wired to production):
1. `aurora-cutover-vector-postload.sql`
2. `aurora-cutover-recreate-foreign-keys.sql`
3. `aurora-cutover-schema-sync-views.sql`
- Owner command required: `TODO: owner to supply` (the psql or `scripts/aws/aurora-run-sql.sh` invocation for production, and its arguments).

2c. Embedding backfill: `scripts/aws/aurora-cutover-embedding-backfill.py` (plan-sparring 11).
- Owner command required: `TODO: owner to supply` (arguments and target).

2d. Privilege parity gate (rehearsal.md section G step 5, with the production cluster name):
- Owner command required:
  `python3 scripts/aws/aurora-privilege-parity.py --check --strict --cluster vitana-aurora-prod --supabase-snapshot $SUPABASE_SNAPSHOT_JSON --role-map postgres=$AURORA_OWNER_ROLE --report docs/validation/VTID-05023/privilege-parity-report-prod.json`
- Do not go on until this exits 0 (plan-sparring part 0). If it fails, stop the window.

2e. Verify the final sync: run `scripts/cutover/verify-cutover.sh` (handover §4). See the blocker in "Before step 1", item 2.
- Owner command required: `TODO: owner to supply` (the verify-cutover invocation and its arguments).

2f. Start the storage-auth CDC task (storage-auth.md, Window order 3). It starts after the final load, after-load and backfill, and before the gateway flip. The rollback-scope task (`--scope rollback`) is also started at this point if option 12(i) is used (plan-sparring 12).
- Owner command required: `TODO: owner to supply` (`aws dms start-replication-task` form and the ARNs `$DMS_STORAGE_AUTH_TASK_ARN`, `$DMS_ROLLBACK_TASK_ARN`).

## Step 3. Migrations (one file per run, in order)

- Repo mechanism: `.github/workflows/RUN-MIGRATION.yml`, `workflow_dispatch` with inputs `migration_file` and `target` (`supabase`, `aurora`, or `default`). With `target=aurora`, the file is applied in one transaction over the RDS Data API (acceptance AC-14).
- Order and content: the list in `docs/validation/VTID-05023/migration-order.md` (agent G, on its own branch, not on `main`). It is pending the owner confirmation O5. Every migration in the list is applied one per dispatch, in the listed order.
- Held drop: `20261102052300_vtid_05573_legacy_messages_drop.sql` is excluded from every apply list (handover §3 B2).
- Stop at the first error and follow the rollback path (handover, rehearsal step 4).
- Owner command required, once per file, for each path `<MIGRATION_FILE>` in the confirmed list:
  `gh workflow run RUN-MIGRATION.yml --repo $REPO -f migration_file=<MIGRATION_FILE> -f target=aurora`
- Also apply `aurora-pgrst-ddl-watch.sql` (the NOTIFY pgrst DDL trigger, plan-sparring part 8). Its place in the order is `TODO: owner to supply`.
- Open conflict: `RUN-MIGRATION.yml` refuses to run while `MIGRATION_FREEZE=true`. See step 1a.

## Step 4. Switch the REST base to Aurora

Ordering: `other-services.md` (Window, steps 3 to 5) puts the production gateway first and sets `DATA_REST_URL` after it. The steps below keep the brief's order. The owner must confirm the order (see open items).

4a. Production gateway on the Aurora proxy. `AWS-PROD-DEPLOY-GATEWAY.yml` sets `SUPABASE_URL` to the Aurora proxy secret and `SUPABASE_PUBLIC_URL` stays on Supabase.
- Inputs in the repo: `deploy_mode` (`promote-staging`, `rebuild-main`, `env-only`) and `data_backend` (`keep`, `aurora`, `supabase`). The `reason` input is required.
- Owner command required:
  `gh workflow run AWS-PROD-DEPLOY-GATEWAY.yml --repo $REPO -f deploy_mode=$DEPLOY_MODE -f data_backend=aurora -f reason="VTID-05023 cutover, gateway to Aurora proxy"`
- `$DEPLOY_MODE`: `env-only` keeps the current production image. The handover requires the gateway deploy to be pinned to the verified commit `$DEPLOYED_COMMIT`. `env-only` does not pin a commit. The owner must choose the mode (see open items).

4b. REST base setting. The setting named in the brief, `DATA_REST_BASE_MODE=aurora_proxy` for production, is agent C's change. It is not on `main` (no match in the repo at `a02b8918f3`). The handover and `other-services.md` use the repo variable `DATA_REST_URL=https://data.vitanaland.com` instead.
- Owner command required: `gh variable set DATA_REST_URL --repo $REPO --body https://data.vitanaland.com` (handover G3, other-services step 5).
- Owner command required: `TODO: owner to supply` for `DATA_REST_BASE_MODE=aurora_proxy` (name, scope and command, once agent C's MR is merged).

4c. Other services, after the gateway (other-services.md, steps 6 and 7). Each one is a workflow dispatch with `data_backend=aurora` and `commit_sha` set to the commit in the live image tag.
- verification-engine, orb-agent: owner command required, workflow file and inputs `TODO: owner to supply` (the workflow file names are not confirmed in this pass).
- autopilot-executor: owner command required, workflow file `TODO: owner to supply`.
- oasis-projector and worker-runner: not dispatched (desired count 0).

## Step 5. Checks

5a. Liveness. Owner command required:
`curl -sS -o /dev/null -w '%{http_code}\n' $GATEWAY_BASE_URL/alive`
Expected: `200`.

5b. Build info matches the deployed commit. Owner command required:
`curl -sS $GATEWAY_BASE_URL/api/v1/admin/build-info`
The response includes `git_commit` (`services/gateway/src/routes/admin-health.ts`, line 80). Expected: `git_commit` equals `$DEPLOYED_COMMIT`. Mismatch means stop and roll back.

5c. One `/rest/v1` read. Owner command required:
`curl -sS -H "apikey: $ANON_KEY" "https://data.vitanaland.com/rest/v1/$SAMPLE_TABLE?select=$SAMPLE_COLUMN&limit=1"`
- `$ANON_KEY` is read from the secret store. It is never written to a file.
- `$SAMPLE_TABLE` and `$SAMPLE_COLUMN` are `TODO: owner to supply`. Pick one table from the feed or profile reads in rehearsal.md section J.
- The brief asks for this read "through the gateway". The handover puts `/rest/v1` on `data.vitanaland.com` (handover §1). Owner must confirm the path.

## Step 6. Two-hour watch

Watch from the flip until T+2h. The thresholds are from rehearsal.md section J: `http_req_failed < 1 %`, p95 below 800 ms, p99 below 2 s on the data host, and no 5xx.

Watch these at the same time:
- Data host: request failure rate, p95, p99, 5xx count on `data.vitanaland.com`.
- Aurora production cluster `vitana-aurora-prod`: `DatabaseConnections`, CPU.
- Proxy task (`vitana-postgrest-aurora-proxy`, production): task CPU.
- Gateway: `/alive` and build-info (repeat step 5a and 5b every 15 minutes, `TODO: owner to supply` for the cadence the owner wants).
- Drift monitor: a 5-minute drift check per table, Supabase against Aurora, excluding tables written by the CDC tasks (plan-sparring 11). Alert on any other change on Supabase.
- DMS tasks: `storage-auth` and rollback tasks running and not in error state.
- Owner command required: `TODO: owner to supply` (dashboard names, log groups and the CLI commands used to read these metrics; none are defined in the repo).

Rollback option 12(i) is available until T+2h. After T+2h, rollback is not offered (plan-sparring 12(i)).

## Step 7. Rollback

Order: switch REST back to Supabase first, then the gateway to the previous revision, then stop the sync. The order is from the brief and matches `other-services.md` (Rollback) and `storage-auth.md` (Rollback).

7a. Switch REST back to Supabase.
- Owner command required: `gh variable delete DATA_REST_URL --repo $REPO` (other-services.md, Rollback: delete the repository variable).
- Owner command required: `TODO: owner to supply` for `DATA_REST_BASE_MODE` back to Supabase (agent C's setting, once it exists).

7b. Gateway to the previous revision on Supabase.
- Owner command required: `gh workflow run AWS-PROD-DEPLOY-GATEWAY.yml --repo $REPO -f deploy_mode=env-only -f data_backend=supabase -f reason="VTID-05023 rollback to Supabase"` (other-services.md, Rollback).
- The supabase references are pinned literals, so this does not depend on reading the secret.
- The "previous revision" ID is not pinned in the repo. `TODO: owner to supply` the revision number if the owner wants a revision pin rather than the data_backend switch.
- Then, per other-services.md: staging gateway with `data_backend=supabase`, orb-agent, verification-engine and autopilot-executor with `data_backend=supabase` and their pinned commits (owner command required, `TODO: owner to supply` for each workflow file).

7c. Stop the sync.
- Stop the DMS tasks: storage-auth CDC and the rollback-scope task. Owner command required: `TODO: owner to supply` (stop command and ARNs `$DMS_STORAGE_AUTH_TASK_ARN`, `$DMS_ROLLBACK_TASK_ARN`).
- Reverse trigger rollback on Supabase, in this order (storage-auth.md, Rollback): 1) stop the tasks, 2) `scripts/aws/supabase-cutover-reverse-cdc-triggers-rollback.sql`, 3) `scripts/aws/supabase-cutover-unschedule-rollback.sql`. Owner command required: `TODO: owner to supply` (psql invocation for each file).
- Delete the rollback-scope DMS task when the T+2h window closes (storage-auth.md, "Schema rule" and scope text). Owner command required: `TODO: owner to supply`.

## Not in this window

- Auth, Storage, Edge Functions and the chat and voucher storage policies stay on Supabase (option B).
- Full Supabase exit (later program).
- Realtime move (`services/realtime-aurora`, port 4000 rule `sg-0fbcf7b59b1f0d685`). It is an owner decision (plan-sparring 7a and 7b).
- Held drop `20261102052300_vtid_05573_legacy_messages_drop.sql`. Excluded from every apply list.
- oasis-projector and worker-runner (desired count 0, not dispatched).
- Any second production Aurora reboot. The one reboot needed is "Before step 1" item 4, and the owner runs it.
- Staging and rehearsal changes (`vitana-aurora-rehearsal*`, `vitana-postgres-staging`, staging gateway schedulers).
- Changes to the `vtid-05005` test.
- Any production DNS change, security-group change, or IAM change (handover §0.2, O1 to O4).

## Open items for the owner

1. Final-copy method. The brief says "pg_dump snapshot plus the storage-auth DMS scope". The handover says "Aurora final copy" and "DMS start" and does not name pg_dump. Confirm the method.
2. Freeze and migrations conflict. `MIGRATION_FREEZE=true` blocks `RUN-MIGRATION.yml`. Decide how step 3 runs during the freeze.
3. REST switch order. The brief puts the REST switch at step 4, and `other-services.md` puts the gateway first and `DATA_REST_URL` after. Confirm the order.
4. `DATA_REST_BASE_MODE` vs `DATA_REST_URL`. Confirm which setting controls REST, and that agent C's setting is on `main` before the window.
5. Gateway deploy mode. `env-only` does not pin a commit. The handover requires the pinned verified commit. Choose the mode and the commit.
6. `verify-cutover.sh`. The file was not readable on `gitlab-migration-prep` (404 on the check). Confirm its branch.
7. Migration list. Confirm O5 and the path of `migration-order.md` on `main`.
8. Storage-auth task order. `storage-auth.md` says stop the tasks first in rollback. The brief's rollback order says REST first, gateway second, sync third. Both are followed as written: the sync stop is step 7c, and within 7c the tasks stop before the trigger rollback.

## Owner commands still needed (TODO list)

| # | Step | What is missing |
|---|---|---|
| T1 | 0.4 Parameter change and reboot | Exact production command for `aurora-cluster-params-cutover.sh --apply` and the reboot |
| T2 | 0.2 verify-cutover | Branch or location of `scripts/cutover/verify-cutover.sh`; invocation |
| T3 | 1a GitHub freeze | Command or procedure for freezing merges; `MIGRATION_FREEZE` set command |
| T4 | 1b Supabase write freeze | psql invocation for `aurora-cutover-freeze-writes.sql` against Supabase |
| T5 | 1c Unschedule and triggers | psql invocations for `supabase-cutover-unschedule.sql` and `supabase-cutover-reverse-cdc-triggers.sql` |
| T6 | 2a Final DMS load | Start command and production task ARN `$DMS_FINAL_TASK_ARN` |
| T7 | 2b After-load | Invocation for production (wrapper or `aurora-run-sql.sh`) |
| T8 | 2c Embedding backfill | Arguments and target for `aurora-cutover-embedding-backfill.py` |
| T9 | 2e verify-cutover run | Invocation and arguments |
| T10 | 2f CDC task start | `aws dms start-replication-task` form and ARNs `$DMS_STORAGE_AUTH_TASK_ARN`, `$DMS_ROLLBACK_TASK_ARN` |
| T11 | 3 Migration list | Confirm O5; path of `migration-order.md` on `main` |
| T12 | 3 Part 8 DDL watch | Place of `aurora-pgrst-ddl-watch.sql` in the order |
| T13 | 4b REST base setting | `DATA_REST_BASE_MODE=aurora_proxy` command, scope and name (agent C's MR) |
| T14 | 4c Other services | Workflow file names and inputs for verification-engine, orb-agent and autopilot-executor |
| T15 | 5 Gateway base URL | `$GATEWAY_BASE_URL` for production |
| T16 | 5c Sample read | `$SAMPLE_TABLE`, `$SAMPLE_COLUMN` and the key source for `$ANON_KEY` |
| T17 | 6 Watch | Dashboard names, log groups, CLI commands and check cadence |
| T18 | 7a REST rollback | `DATA_REST_BASE_MODE` back to Supabase command |
| T19 | 7b Rollback revision | Pinned revision number, if the owner wants one |
| T20 | 7b Rollback of other services | Workflow file names and pinned commits |
| T21 | 7c Stop DMS | Stop and delete commands and ARNs |
| T22 | 7c Trigger rollback | psql invocations for `supabase-cutover-reverse-cdc-triggers-rollback.sql` and `supabase-cutover-unschedule-rollback.sql` |
