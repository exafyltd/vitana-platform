# plan(VTID-05023): staging Aurora cluster from a read-only Supabase snapshot

Status: plan only. Nothing is created in AWS until this plan converges through CI plan sparring.

## Facts checked in the repo

- Staging reads and writes the production Supabase project (`https://inmkhvwdcuyhnxkgfvsb.supabase.co`). `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE` come from repo secrets that point there. The `SUPABASE_JWT_SECRET` and `SUPABASE_ANON_KEY` task-definition secrets come from `vitana/supabase/prod/*`.
- No staging Supabase project exists. Creating one is an owner decision, recorded as an open item. This plan does not depend on it.
- The only Aurora cluster is `vitana-aurora-prod`. There is no staging Aurora cluster.

## Scope

- VTID: VTID-05023 (cutover, option B).
- Creates, after convergence: one Aurora PostgreSQL 17 cluster for staging, `vitana-aurora-staging`, in account 472838866351, eu-central-1, with parameter group `vitana-aurora-pg17-staging`.
- Loads: a point-in-time dump of production Supabase, taken with `pg_dump` and restored into the staging cluster.
- Does not change: the staging gateway's `SUPABASE_URL`, its service-role key, or its JWT and anon keys. Staging logins keep working.
- Does not touch: production Supabase, `vitana-aurora-prod`, `vitana-postgres-staging`, or any production secret.

## Production access rule

Production Supabase is read-only for this plan. The only operation on it is a `pg_dump` run with a read-only snapshot transaction (default `pg_dump` behaviour). The plan does not create roles, change settings, enable replication or logical decoding, create publications or slots, or run DMS. The credential used for the dump is an existing one. The owner chooses it and records the choice in the lane. The plan does not add a new database role on production.

## Steps

0. **Confirm the snapshot source.** The owner names the existing read-only credential for production Supabase, and the dump command is recorded with its exact flags. Stop if no read-only credential is available. Do not create one on production.
1. **Take the snapshot.** Run `pg_dump --format=custom --no-owner --no-privileges` against production Supabase, writing a single dump file to a staging S3 bucket with server-side encryption. Record the file's SHA-256 and the snapshot time in the lane. Snapshot time is the only freshness the staging copy has. There is no ongoing sync.
2. **Create the cluster.** Create `vitana-aurora-staging` through IaC, not a console change. Set `rds.logical_replication` only if a later plan requires it. Check the account before every AWS call.
3. **Restore.** Run `pg_restore` from the dump into the staging cluster. Stop at the first error and record the output. The restore writes only to `vitana-aurora-staging`.
4. **Apply the Aurora compatibility layer** (`supabase/migrations/<timestamp>_aurora_compat_layer.sql`, once it exists and only on Aurora targets), then run the migration drift check against the staging cluster. Migration list is pending owner step O5.
5. **Parity.** Compare row counts and per-table checksums between the dump and the restored cluster. Write `docs/validation/VTID-05023/parity-staging.md`. Zero mismatched tables is the pass condition. Because both sides come from the same dump, this checks the restore, not production drift.
6. **Staging gateway switch (separate change, not part of this plan's execution).** Pointing the staging gateway at the new cluster changes the staging data path. It needs its own plan, the owner's decision on the staging Supabase question, and a deploy through `AWS-STAGE-DEPLOY-GATEWAY.yml`. It is listed here so the rollback covers it, and it is not run under this plan.

## Test plan

- Dump file integrity: SHA-256 recorded at step 1 and checked before restore.
- Restore: `pg_restore` exits 0 with no errors.
- Parity: `parity-staging.md` shows zero mismatched tables (step 5).
- Compatibility layer on the staging cluster: an RLS policy using `auth.uid()` returns rows when the session setting is set and none when it is not (see the layer's own test).
- Step 6 adds the smoke test (`/api/v1/admin/health` reports `env=staging`, `/api/v1/admin/build-info` matches the deployed SHA). It runs only with step 6.

## Rollback

- Before step 6: nothing has moved. Rollback is to stop. The staging cluster can stay, or be deleted in a separate change the owner approves.
- After step 6 (if ever run): switch the staging gateway back to the previous build through `AWS-STAGE-DEPLOY-GATEWAY.yml` with `workflow_dispatch` on the previous good SHA, which restores the old Supabase data path.
- The dump file and the staging cluster are kept until the owner decides to remove them.

## Open items

- O5: confirm the migration set for step 4.
- Owner decision: whether a separate staging Supabase project should be created. It is not needed by this plan.
- Owner decision: which existing read-only credential the step 0 dump uses.
