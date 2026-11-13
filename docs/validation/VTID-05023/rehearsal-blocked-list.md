# VTID-05023 rehearsal-blocked list

Status: checklist for the lead. Nothing in this file has been run. Kiro ran no command against the rehearsal clone, production, AWS, or any database while writing it.

Base: `origin/main` at `c7e17d64d9`. Branch `cutover/vtid-05023-R5O-rehearsal-list`.

## Sources and where they live

- Lane file: `docs/validation/VTID-05023/lane.md` on `origin/cutover/vtid-05023-lane` (latest round is Round 6). Not on main.
- Window runbook: `docs/validation/VTID-05023/window-runbook.md` is not on main. It is on `origin/cutover/vtid-05023-D-window-runbook` at `a8ad02274c`. This list reads it from that ref.
- Rehearsal runbook: `docs/validation/VTID-05023/rehearsal.md` on main, sections G and J.
- Handover: `docs/handover/VTID-05023/KIRO-HANDOVER.md` on `origin/cutover/vtid-05023-handover`.
- Welcome skip test report: `docs/validation/VTID-05023/agents/M4-welcome-skip-test.md` on `origin/cutover/vtid-05023-M4-welcome-skip-test` (MR !32, commit `6464fb9664` has the corrected query).

## How to read this list

- The 100-task list is not in the repo. Each item carries the step ID from its source document (rehearsal.md section letter, handover task ID, or runbook step number). Map these to the 100-task numbers.
- `TODO: owner to supply` means the repo has no command for that step. Do not invent one.
- `owner command required` marks every production step. The lead does not run Section B.
- Output paths marked "proposed" are not named in the repo. The owner confirms them.

Counts: Section A has 19 items, Section B has 35, Section C has 22.

---

## Section A. RUN ON REHEARSAL BY THE LEAD (Data API access)

Scope: database-touching rehearsal steps named by the lead. Staging gateway, staging app, STAGING-VERIFY and the load test (rehearsal.md G6 to G10 and J) are not listed, because they run against staging.

A `scripts/aws/rehearsal-clone.sh` subcommand accepts only the clone. Its `sql` action takes a file and runs it on the clone. Expected results come from the cited documents.

- [ ] **A1. rehearsal.md G3, neutralise the clone.**
  - Command: `bash scripts/aws/rehearsal-clone.sh sql scripts/aws/rehearsal-clone-neutralize.sql`
  - Expected: exit 0. Every statement in the file raises unless it runs on `vitana-aurora-rehearsal-writer`, so a raise is a failure.
  - Write output to: `docs/validation/VTID-05023/rehearsal-1.md` (proposed; the name is implied by `rehearsal-2.md` in handover E1).

- [ ] **A2. rehearsal.md G4.1, schema sync (idempotent).**
  - Command: `bash scripts/aws/rehearsal-clone.sh sql scripts/aws/aurora-cutover-schema-sync.sql`
  - Expected: exit 0. A rerun on the clone must also exit 0.
  - Write output to: `docs/validation/VTID-05023/rehearsal-1.md` (proposed).

- [ ] **A3. rehearsal.md G4.2, vector post-load.**
  - Command: `bash scripts/aws/rehearsal-clone.sh sql scripts/aws/aurora-cutover-vector-postload.sql`
  - Expected: exit 0.
  - Write output to: `docs/validation/VTID-05023/rehearsal-1.md` (proposed).

- [ ] **A4. rehearsal.md G4.2, recreate foreign keys.**
  - Command: `bash scripts/aws/rehearsal-clone.sh sql scripts/aws/aurora-cutover-recreate-foreign-keys.sql`
  - Expected: exit 0.
  - Write output to: `docs/validation/VTID-05023/rehearsal-1.md` (proposed).

- [ ] **A5. rehearsal.md G4.2, schema sync views.**
  - Command: `bash scripts/aws/rehearsal-clone.sh sql scripts/aws/aurora-cutover-schema-sync-views.sql`
  - Expected: exit 0. Run A3 to A5 one by one. The wrapper `aurora-cutover-after-load.sh` is hard-wired to production and must not be used here.
  - Write output to: `docs/validation/VTID-05023/rehearsal-1.md` (proposed).

- [ ] **A6. rehearsal.md G4.3, auth bridge (part 4).**
  - Command: `bash scripts/aws/rehearsal-clone.sh sql scripts/aws/aurora-cutover-auth-bridge.sql`
  - Expected: exit 0.
  - Write output to: `docs/validation/VTID-05023/rehearsal-1.md` (proposed).

- [ ] **A7. rehearsal.md G4.4, outbox (part 6 B), then verify.**
  - Command: `bash scripts/aws/rehearsal-clone.sh sql scripts/aws/aurora-cutover-outbox.sql`
  - Then verify that `notify_welcome_discount()` on the clone no longer needs `pg_net`. The verification query is `TODO: owner to supply`.
  - Expected: exit 0, and the verification result recorded as pass or fail.
  - Write output to: `docs/validation/VTID-05023/rehearsal-1.md` (proposed).

- [ ] **A8. rehearsal.md G4.5, cron (part 6 A), then verify.**
  - Command: `bash scripts/aws/rehearsal-clone.sh sql scripts/aws/aurora-cutover-cron.sql`
  - The file needs `pg_cron` preloaded. The clone's group copy has it.
  - Then verify that jobs 20 and 21 make no HTTP call. The verification query is `TODO: owner to supply`.
  - Expected: exit 0, and the verification result recorded.
  - Write output to: `docs/validation/VTID-05023/rehearsal-1.md` (proposed).

- [ ] **A9. rehearsal.md G4.6, realtime (part 7a). Run only if the clone has `logical_replication=true` (rehearsal.md section H).**
  - Command: `bash scripts/aws/rehearsal-clone.sh sql scripts/aws/aurora-realtime-setup.sql`
  - Expected: exit 0. If the clone does not have `logical_replication=true`, skip this item and record that it was skipped.
  - Write output to: `docs/validation/VTID-05023/rehearsal-1.md` (proposed).

- [ ] **A10. rehearsal.md G4.7, part-8 NOTIFY pgrst DDL trigger.**
  - Command: `bash scripts/aws/rehearsal-clone.sh sql scripts/aws/aurora-pgrst-ddl-watch.sql`
  - The rehearsal.md file name is "agent A's file, when it exists". This file name comes from handover Part 2. Confirm it is the part-8 trigger before running.
  - Expected: exit 0.
  - Write output to: `docs/validation/VTID-05023/rehearsal-1.md` (proposed).

- [ ] **A11. Handover C3, migrations (B2 set) on the clone. Blocked.**
  - Command: `TODO: owner to supply`. Do not use `scripts/aws/aurora-apply-migration.sh`. Its line 37 sets `CLUSTER=vitana-aurora-prod`, so it targets production.
  - Blocked by owner decision O5 (the B2 list is not defined in the repo; see C7).
  - Expected: each migration result recorded per file, and the chain stops at the first error (handover C3).
  - Write output to: `docs/validation/VTID-05023/rehearsal-1.md` (proposed).

- [ ] **A12. Handover C4, parity on the clone (row counts and checksums of the 5 storage-auth tables and the rest of `public`, Supabase against clone, one fixed snapshot).**
  - Command: `TODO: owner to supply`. The repo names the output file only.
  - Expected: `TODO: owner to supply`. The handover does not state a pass criterion.
  - Write output to: `docs/validation/VTID-05023/parity-rehearsal-1.md` (named in handover C4).

- [ ] **A13. rehearsal.md G5, privilege parity (part 0) on the clone. Nothing on staging points at the clone until this exits 0.**
  - Command:
    ```
    python3 scripts/aws/aurora-privilege-parity.py --check --strict --cluster vitana-aurora-rehearsal --supabase-snapshot supabase-snapshot.json --role-map postgres=<aurora owner role> --report docs/validation/VTID-05023/privilege-parity-report-clone.json
    ```
  - Replace `<aurora owner role>` with the owner role name. The repo does not name it. The `supabase-snapshot.json` input is the output of a snapshot SQL file that the repo does not name; `TODO: owner to supply` for that file.
  - Expected: exit 0. On failure, stop. Do not run `--fix` without review (rehearsal.md G5 says to review, apply with `rehearsal-clone.sh sql`, then re-check).
  - Write output to: `docs/validation/VTID-05023/privilege-parity-report-clone.json` (named in rehearsal.md G5).

- [ ] **A14. fn_consume_credits privilege check on the rehearsal.**
  - Requires migration `supabase/migrations/20261008170000_vtid_04981_consume_credits_lockdown.sql` applied on the clone. The repo has no documented command to run this on the rehearsal. The SQL below is the repo's own assertion (`supabase/tests/vtid_04981_consume_credits_lockdown.test.sql`, lines 7 to 11) written as a SELECT:
    ```sql
    SELECT
      has_function_privilege('authenticated', 'public.fn_consume_credits(uuid,uuid,integer,text,text,text)', 'EXECUTE') AS authenticated,
      has_function_privilege('anon',          'public.fn_consume_credits(uuid,uuid,integer,text,text,text)', 'EXECUTE') AS anon,
      has_function_privilege('service_role',  'public.fn_consume_credits(uuid,uuid,integer,text,text,text)', 'EXECUTE') AS service_role;
    ```
  - Expected: `authenticated` false, `anon` false, `service_role` true.
  - Write output to: `docs/validation/VTID-05023/rehearsal-1.md` (proposed).

- [ ] **A15. Welcome skip test on the rehearsal clone (M4 report section 1).**
  - Repo command, local only: `node docs/validation/VTID-05507/pglite-harness/run.mjs --sql supabase/tests/vtid_05623_welcome_skip_fixture.sql --sql supabase/migrations/20261113120000_vtid_05623_welcome_trigger_service_account_skip.sql supabase/tests/vtid_05623_welcome_skip.test.sql`
  - That command runs in-memory PGlite, not the clone. A PGlite pass is not a rehearsal pass.
  - Clone run command: `TODO: owner to supply`. The skip migration and test are on the M4 branch (MR !32, stacked on MR !28), not on main. Apply the migration on the clone first.
  - Expected from the local run: `1..7`, seven `ok` lines, exit 0.
  - Write output to: `docs/validation/VTID-05023/agents/M4-welcome-skip-test.md`, section 5 (on the M4 branch).

- [ ] **A16. a27552a3 read-only check, with the corrected column from MR !32.**
  - Read only. Do not write to this account.
  - Before running, confirm the column `user_id` against the live `notification_test_actors` table. The repo has no CREATE TABLE for it, and migrations read `user_id` (for example `supabase/migrations/20260924150000_vtid_04483_profile_health_summary.sql`, line 121, and `supabase/migrations/20260929120400_vtid_04741_confirm_commission_order_lock_exclusions.sql`, line 46).
  - Query:
    ```sql
    SELECT user_id FROM notification_test_actors WHERE user_id = 'a27552a3-0257-4305-8ed0-351a80fd3701';
    ```
  - Expected: the repo gives no expected value. Record the row count (0 or 1) as the result.
  - Write output to: `docs/validation/VTID-05023/agents/M4-welcome-skip-test.md`, section 5 (on the M4 branch).

- [ ] **A17. verify-cutover.sh on the rehearsal (handover G1 and V6; runbook step 2e). Blocked.**
  - Command: `TODO: owner to supply`. The script is not on main and not in any ref in this clone. The runbook records a 404 for branch `gitlab-migration-prep` in project 2.
  - Blocked until the owner gives the script's branch and arguments (see C6).
  - Expected: `TODO: owner to supply`.
  - Write output to: `docs/validation/VTID-05023/verify-cutover-rehearsal.md` (proposed; runbook E2 expects the result in the readiness pack).

- [ ] **A18. Rollback dry run (rehearsal.md G11 and runbook step 7). Blocked by design.**
  - Script: `scripts/cutover/rollback-dry-run.sh`, on branch `cutover/vtid-05023-L-rollback-drill`. It is not on main.
  - Command (dry run, no `--execute`): `scripts/cutover/rollback-dry-run.sh --previous-revision <n> --target staging`. `<n>` is `TODO: owner to supply`.
  - The script accepts only `--target staging`, so it cannot target the rehearsal clone (see C9).
  - Expected: without `--verify-aws`, each check prints as not verified and no AWS call is made. The exit code is not documented.
  - Write output to: `docs/validation/VTID-05023/rollback-dry-run-rehearsal.md` (proposed).

- [ ] **A19. E1 second full rehearsal from a fresh clone (handover E1). Reruns A1 to A16 on the new clone.**
  - Step 1 (AWS, not a database run): `scripts/aws/rehearsal-clone.sh create`. Handover C1 says it resumes a half-built clone and refuses untagged clusters. The script's usage line also lists `--dry-run`, which can be used first.
  - Then repeat A1 to A16 on the new clone, including parity in A12 and A13.
  - Expected: the second run must be clean (handover E1).
  - Write output to: `docs/validation/VTID-05023/rehearsal-2.md` (named in handover E1).

---

## Section B. OWNER-ONLY PRODUCTION STEPS

Every item in this section touches production, Supabase production, or the production Aurora cluster `vitana-aurora-prod`. The lead and Kiro do not run any of them. Source: `window-runbook.md` on `origin/cutover/vtid-05023-D-window-runbook` (step numbers match that file).

Before step 1 (owner checks):

- [ ] **B1. Before step 1, item 4. Aurora parameter change and reboot (cluster `vitana-aurora-prod`, group `vitana-aurora-pg17-prod`).**
  - Command: `scripts/aws/aurora-cluster-params-cutover.sh --apply` is the apply form, and it is dry-run by default. Exact production invocation and reboot command: `TODO: owner to supply`.
  - Owner command required.

- [ ] **B2. Before step 1, item 5. Port 4000 security-group rule `sg-0fbcf7b59b1f0d685`. Only if Realtime moves in this window (see C12).**
  - Command: `TODO: owner to supply`.
  - Owner command required.

- [ ] **B3. Before step 1, item 6. `aws dms test-connection` on both reverse endpoints.**
  - Command: `TODO: owner to supply` (endpoint identifiers are not in the repo).
  - Owner command required.

- [ ] **B4. Before step 1, item 8. Account check.**
  - Command: `aws sts get-caller-identity`. The output must show account `472838866351` (handover V1). Run before every AWS call in the window.
  - Owner command required.

Step 1 (freeze writes):

- [ ] **B5. Step 1a. GitHub freeze of merges and migration dispatches, plus the `MIGRATION_FREEZE` variable.**
  - Command: `TODO: owner to supply` for the freeze procedure and for the command that sets `MIGRATION_FREEZE`.
  - Owner command required. Conflict with B15 (see C2).

- [ ] **B6. Step 1b. Supabase database write freeze.**
  - File: `scripts/aws/aurora-cutover-freeze-writes.sql`, run against Supabase, not Aurora. Its header names the 2026-09-20 window and VTID-04084, so check it before reuse.
  - Command: psql invocation `TODO: owner to supply`, with the database URL from the masked GitLab variable.
  - Owner command required.

- [ ] **B7. Step 1c. Unschedule Supabase cron.**
  - File: `scripts/aws/supabase-cutover-unschedule.sql`.
  - Command: psql invocation `TODO: owner to supply`.
  - Owner command required.

- [ ] **B8. Step 1c. Disable the 239 Supabase user triggers on 152 `public` tables (FK triggers stay on).**
  - File: `scripts/aws/supabase-cutover-reverse-cdc-triggers.sql`.
  - Command: psql invocation `TODO: owner to supply`.
  - Owner command required.

Step 2 (final copy):

- [ ] **B9. Step 2a. Final DMS load start.**
  - File: `scripts/aws/aurora-cutover-final-catchup-task.sh` creates the task definition. The start command and ARN `$DMS_FINAL_TASK_ARN` are `TODO: owner to supply`. The final-copy method is open (see C1).
  - Owner command required.

- [ ] **B10. Step 2b. After-load on production Aurora, in this order: `aurora-cutover-vector-postload.sql`, `aurora-cutover-recreate-foreign-keys.sql`, `aurora-cutover-schema-sync-views.sql`.**
  - Command: psql or `scripts/aws/aurora-run-sql.sh` invocation `TODO: owner to supply`. `aurora-run-sql.sh` is hard-wired to production (rehearsal.md G4).
  - Owner command required.

- [ ] **B11. Step 2c. Embedding backfill.**
  - File: `scripts/aws/aurora-cutover-embedding-backfill.py`.
  - Command: arguments and target `TODO: owner to supply`.
  - Owner command required.

- [ ] **B12. Step 2d. Privilege parity gate, production.**
  - Command:
    ```
    python3 scripts/aws/aurora-privilege-parity.py --check --strict --cluster vitana-aurora-prod --supabase-snapshot $SUPABASE_SNAPSHOT_JSON --role-map postgres=$AURORA_OWNER_ROLE --report docs/validation/VTID-05023/privilege-parity-report-prod.json
    ```
  - Expected: exit 0. If it fails, stop the window.
  - Owner command required.

- [ ] **B13. Step 2e. verify-cutover, final sync.**
  - Command: `TODO: owner to supply`. Blocked by C6.
  - Owner command required.

- [ ] **B14. Step 2f. Start the storage-auth CDC task, and the rollback-scope task if option 12(i) is used.**
  - Command: `aws dms start-replication-task` form `TODO: owner to supply`, with ARNs `$DMS_STORAGE_AUTH_TASK_ARN` and `$DMS_ROLLBACK_TASK_ARN`.
  - Owner command required.

Step 3 (migrations):

- [ ] **B15. Step 3. Apply each confirmed migration, one per dispatch, in the confirmed order.**
  - Command: `gh workflow run RUN-MIGRATION.yml --repo $REPO -f migration_file=<MIGRATION_FILE> -f target=aurora`
  - `<MIGRATION_FILE>` comes from the list in `docs/validation/VTID-05023/migration-order.md` on `origin/cutover/vtid-05023-G-migration-inventory`. The list is not confirmed (O5, see C7). The held drop `20261102052300_vtid_05573_legacy_messages_drop.sql` is excluded.
  - This runs while `MIGRATION_FREEZE` may be `true`, which blocks `RUN-MIGRATION.yml` (see C2).
  - Owner command required.

- [ ] **B16. Step 3. Part 8 DDL watch, `scripts/aws/aurora-pgrst-ddl-watch.sql`.**
  - Place in the order and command: `TODO: owner to supply`.
  - Owner command required.

Step 4 (REST switch):

- [ ] **B17. Step 4a. Production gateway on the Aurora proxy.**
  - Command: `gh workflow run AWS-PROD-DEPLOY-GATEWAY.yml --repo $REPO -f deploy_mode=$DEPLOY_MODE -f data_backend=aurora -f reason="VTID-05023 cutover, gateway to Aurora proxy"`
  - `$DEPLOY_MODE` is open (see C5). `env-only` does not pin `$DEPLOYED_COMMIT`. GitHub CLI use is open (see C10).
  - Owner command required.

- [ ] **B18. Step 4b. Set the repository variable `DATA_REST_URL`.**
  - Command: `gh variable set DATA_REST_URL --repo $REPO --body https://data.vitanaland.com`
  - Owner command required.

- [ ] **B19. Step 4b. Set `DATA_REST_BASE_MODE=aurora_proxy` (agent C's setting, not on main).**
  - Command, name and scope: `TODO: owner to supply`. Which setting controls REST is open (see C4).
  - Owner command required.

- [ ] **B20. Step 4c. Dispatch verification-engine with `data_backend=aurora` and `commit_sha` set to the live image commit.**
  - Workflow file and inputs: `TODO: owner to supply`.
  - Owner command required.

- [ ] **B21. Step 4c. Dispatch orb-agent with `data_backend=aurora` and `commit_sha` set to the live image commit.**
  - Workflow file and inputs: `TODO: owner to supply`.
  - Owner command required.

- [ ] **B22. Step 4c. Dispatch autopilot-executor with `data_backend=aurora` and `commit_sha` set to the live image commit.**
  - Workflow file and inputs: `TODO: owner to supply`.
  - Owner command required. oasis-projector and worker-runner are not dispatched (desired count 0).

Step 5 (checks):

- [ ] **B23. Step 5a. Gateway liveness.**
  - Command: `curl -sS -o /dev/null -w '%{http_code}\n' $GATEWAY_BASE_URL/alive`
  - Expected: `200`. `$GATEWAY_BASE_URL` is `TODO: owner to supply`.
  - Owner command required.

- [ ] **B24. Step 5b. Build info matches the deployed commit.**
  - Command: `curl -sS $GATEWAY_BASE_URL/api/v1/admin/build-info`
  - Expected: `git_commit` equals `$DEPLOYED_COMMIT`. A mismatch means stop and roll back.
  - Owner command required.

- [ ] **B25. Step 5c. One `/rest/v1` read.**
  - Command: `curl -sS -H "apikey: $ANON_KEY" "https://data.vitanaland.com/rest/v1/$SAMPLE_TABLE?select=$SAMPLE_COLUMN&limit=1"`
  - `$SAMPLE_TABLE` and `$SAMPLE_COLUMN` are `TODO: owner to supply`. `$ANON_KEY` comes from the secret store and is never written to a file. Whether the read goes through the gateway or `data.vitanaland.com` is open (see C3).
  - Owner command required.

Step 6 (two-hour watch):

- [ ] **B26. Step 6. Repeat the liveness and build-info checks every 15 minutes until T+2h.**
  - Commands: B23 and B24. Cadence confirmed by the owner. Dashboard names, log groups and metric commands for the data host, `vitana-aurora-prod`, the proxy task, and DMS are `TODO: owner to supply`.
  - Owner command required.

- [ ] **B27. Step 6. Drift monitor, a 5-minute drift check per table, Supabase against Aurora, excluding CDC-written tables.**
  - Command: `TODO: owner to supply`. The runbook cites plan-sparring part 11 for the design.
  - Owner command required.

Step 7 (rollback):

- [ ] **B28. Step 7a. Switch REST back to Supabase, part 1: delete the repository variable.**
  - Command: `gh variable delete DATA_REST_URL --repo $REPO`
  - Owner command required. Runs first in the rollback order (see C8).

- [ ] **B29. Step 7a. Switch REST back to Supabase, part 2: `DATA_REST_BASE_MODE` back to Supabase.**
  - Command: `TODO: owner to supply`.
  - Owner command required.

- [ ] **B30. Step 7b. Gateway to the previous revision on Supabase.**
  - Command: `gh workflow run AWS-PROD-DEPLOY-GATEWAY.yml --repo $REPO -f deploy_mode=env-only -f data_backend=supabase -f reason="VTID-05023 rollback to Supabase"`
  - Pinned revision number, if the owner wants a revision pin rather than the `data_backend` switch: `TODO: owner to supply`.
  - Owner command required.

- [ ] **B31. Step 7b. Roll back verification-engine, orb-agent and autopilot-executor to `data_backend=supabase` and their pinned commits.**
  - Workflow files and pinned commits: `TODO: owner to supply`.
  - Owner command required.

- [ ] **B32. Step 7c. Stop the DMS tasks: storage-auth CDC and the rollback-scope task.**
  - Command: stop command and ARNs `$DMS_STORAGE_AUTH_TASK_ARN` and `$DMS_ROLLBACK_TASK_ARN`: `TODO: owner to supply`.
  - Owner command required. Runs before the trigger rollback in storage-auth.md order (see C8).

- [ ] **B33. Step 7c. Reverse trigger rollback, part 1: `scripts/aws/supabase-cutover-reverse-cdc-triggers-rollback.sql` against Supabase.**
  - Command: psql invocation `TODO: owner to supply`.
  - Owner command required.

- [ ] **B34. Step 7c. Reverse trigger rollback, part 2: `scripts/aws/supabase-cutover-unschedule-rollback.sql` against Supabase.**
  - Command: psql invocation `TODO: owner to supply`.
  - Owner command required.

- [ ] **B35. Step 7c. Delete the rollback-scope DMS task when the T+2h window closes.**
  - Command: `TODO: owner to supply`.
  - Owner command required.

---

## Section C. OPEN OWNER DECISIONS

Evidence paths use the form `branch:path`. A path with no branch prefix is on main.

- [ ] **C1. Final-copy method.** The brief says "pg_dump snapshot plus the storage-auth DMS scope". The handover says "Aurora final copy" and "DMS start" and does not name pg_dump. Evidence: `cutover/vtid-05023-D-window-runbook:docs/validation/VTID-05023/window-runbook.md` (step 2 and open item 1); `cutover/vtid-05023-handover:docs/handover/VTID-05023/KIRO-HANDOVER.md` (section 4).

- [ ] **C2. Migrations versus the freeze.** `MIGRATION_FREEZE=true` makes `RUN-MIGRATION.yml` refuse to run, and `aurora-apply-migration.sh` also checks the same variable (line 55). Step 3 cannot run inside the freeze as written. Evidence: `cutover/vtid-05023-D-window-runbook:docs/validation/VTID-05023/window-runbook.md` (step 1a and open item 2); `docs/validation/VTID-05023/outputs/aurora-migrations.txt`; `.github/workflows/RUN-MIGRATION.yml`.

- [ ] **C3. REST switch order.** The brief puts the REST switch at step 4. `other-services.md` puts the gateway first and `DATA_REST_URL` after. Evidence: `cutover/vtid-05023-D-window-runbook:docs/validation/VTID-05023/window-runbook.md` (open item 3); `docs/validation/VTID-05023/other-services.md` (section 4, Window steps).

- [ ] **C4. Which setting controls REST.** The brief names `DATA_REST_BASE_MODE=aurora_proxy`. That setting is agent C's change and is not on main. The handover and `other-services.md` use the repository variable `DATA_REST_URL`. Evidence: `cutover/vtid-05023-D-window-runbook:docs/validation/VTID-05023/window-runbook.md` (step 4b and open item 4).

- [ ] **C5. Gateway deploy mode.** `env-only` does not pin a commit. The handover requires the pinned verified commit `$DEPLOYED_COMMIT`. Evidence: `cutover/vtid-05023-D-window-runbook:docs/validation/VTID-05023/window-runbook.md` (step 4a and open item 5); `cutover/vtid-05023-handover:docs/handover/VTID-05023/KIRO-HANDOVER.md` (section 4).

- [ ] **C6. Location of `verify-cutover.sh`.** A GitLab API check returned 404 for branch `gitlab-migration-prep` in project 2. The script is not in any ref in this clone. Evidence: `cutover/vtid-05023-D-window-runbook:docs/validation/VTID-05023/window-runbook.md` (before step 1, item 2; open item 6); `cutover/vtid-05023-lane:docs/validation/VTID-05023/lane.md` (Round 4, step 5).

- [ ] **C7. Migration list (O5).** The B2 apply set is not defined in the repo. The list file `docs/validation/VTID-05023/migration-order.md` is on `cutover/vtid-05023-G-migration-inventory`, not on main. Evidence: `cutover/vtid-05023-lane:docs/validation/VTID-05023/lane.md` (Phase B, B-O5); `cutover/vtid-05023-D-window-runbook:docs/validation/VTID-05023/window-runbook.md` (step 3 and open item 7).

- [ ] **C8. Rollback order.** The runbook and `scripts/cutover/rollback-dry-run.sh` put REST first, then the gateway, then the sync stop. `storage-auth.md` says stop the tasks first. Evidence: `cutover/vtid-05023-D-window-runbook:docs/validation/VTID-05023/window-runbook.md` (step 7 and open item 8); `docs/validation/VTID-05023/storage-auth.md` (Window order and Rollback).

- [ ] **C9. The rollback dry run has no rehearsal target.** `scripts/cutover/rollback-dry-run.sh` accepts only `--target staging` and refuses production. Decide whether it runs on the rehearsal, and how. Evidence: `cutover/vtid-05023-L-rollback-drill:scripts/cutover/rollback-dry-run.sh` (header lines 11 and 18).

- [ ] **C10. GitHub or GitLab for the production commands.** The runbook writes `gh workflow run` and `gh variable set` (GitHub). The lane says GitHub is not used: the GitHub token returned 401, and the staging deploy ran as GitLab job `gateway-staging-deploy` in `infra/gitlab-engineering/ci/staging-gateway-deploy.gitlab-ci.yml`. Decide the production path, and the GitLab equivalent if it is GitLab. Evidence: `cutover/vtid-05023-lane:docs/validation/VTID-05023/lane.md` (Round 4 step 1; Round 5 header); `cutover/vtid-05023-D-window-runbook:docs/validation/VTID-05023/window-runbook.md` (steps 3, 4a, 4b, 7a, 7b).

- [ ] **C11. Scope of the merge freeze.** rehearsal.md G0 freezes merges that touch `services/gateway/**` and `services/postgrest-aurora-proxy/**` for the rehearsal. The handover does not say whether production uses the same freeze. Evidence: `docs/validation/VTID-05023/rehearsal.md` (G0); `cutover/vtid-05023-D-window-runbook:docs/validation/VTID-05023/window-runbook.md` (step 1a).

- [ ] **C12. Realtime move, in or out of this window.** It needs the port 4000 rule (B2). The runbook lists it under "Not in this window". Evidence: `docs/validation/VTID-05023/plan-sparring.md` (parts 7a and 7b); `cutover/vtid-05023-D-window-runbook:docs/validation/VTID-05023/window-runbook.md` ("Not in this window").

- [ ] **C13. Welcome fan-out recipients.** The welcome fan-out still sends to service and test accounts. The skip only stops those accounts from sending or enrolling. Filtering recipients changes behaviour, so the owner decides. Evidence: `cutover/vtid-05023-M4-welcome-skip-test:docs/validation/VTID-05023/agents/M4-welcome-skip-test.md` (findings for the owner).

- [ ] **C14. Missing allowlist table.** If `notification_test_actors` is missing, every welcome is skipped with a WARNING. This is designed behaviour, and the owner must check logs after deploy. Evidence: `cutover/vtid-05023-M4-welcome-skip-test:docs/validation/VTID-05023/agents/M4-welcome-skip-test.md` (findings for the owner).

- [ ] **C15. Wire the loud-failure test into CI.** `supabase/tests/vtid_05623_welcome_warning.test.mjs` is not run by `supabase test db`. The owner decides whether to add a CI step. Evidence: `cutover/vtid-05023-M4-welcome-skip-test:docs/validation/VTID-05023/agents/M4-welcome-skip-test.md` (findings for the owner).

- [ ] **C16. Confirm the `user_id` column before A16.** The corrected query in MR !32 uses `user_id`. The owner confirms it against the live table on the rehearsal clone. Evidence: `cutover/vtid-05023-M4-welcome-skip-test:docs/validation/VTID-05023/agents/M4-welcome-skip-test.md` (section 5, commit `6464fb9664`); `supabase/migrations/20260924150000_vtid_04483_profile_health_summary.sql` (line 121).

- [ ] **C17. Staging still reads production Supabase.** No staging Supabase project exists. Creating one is an owner decision. Evidence: `cutover/vtid-05023-lane:docs/validation/VTID-05023/lane.md` (Round 2 step 6; Round 4; Round 5 step 4).

- [ ] **C18. Flaky `vtid-05005` tamper test.** A fix needs owner approval. This list does not touch the test. Evidence: `cutover/vtid-05023-lane:docs/validation/VTID-05023/lane.md` (Round 5, step 2 and open items).

- [ ] **C19. Lane claim.** The queue refuses the real session id `8e42cb36-56f1-4d98-b4e4-96425028a531`. Decide the queue format or an approved id for the lane. Evidence: `cutover/vtid-05023-lane:docs/validation/VTID-05023/lane.md` (Claim; blocker L-CLAIM).

- [ ] **C20. Access for this sandbox.** The owner attaches ECS read permissions to role `kiro-1-dstevanovic`, and restores GitLab API access. Without them, task definitions and MR state cannot be read. Evidence: `cutover/vtid-05023-lane:docs/validation/VTID-05023/lane.md` (Round 3, open items; Round 6, open problem).

- [ ] **C21. Revision `vitana-gateway:1010` is not confirmed clean.** The gate line did not print in the deploy job log. A read-only check is needed: `aws ecs describe-task-definition --task-definition vitana-gateway:1010` must show no `AURORA_` names in `containerDefinitions[*].environment` or `.secrets`. Evidence: `cutover/vtid-05023-lane:docs/validation/VTID-05023/lane.md` (Round 6, open problem).

- [ ] **C22. Revoke the token exposed in chat (owner step O6).** Evidence: `cutover/vtid-05023-lane:docs/validation/VTID-05023/lane.md` (Owner steps still open, O6). The token value is not written here.
