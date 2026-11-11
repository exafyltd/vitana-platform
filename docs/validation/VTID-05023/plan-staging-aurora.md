# plan(VTID-05023): staging Aurora cluster, mirrored from Supabase staging

Status: plan only. Nothing is created until this plan converges through CI plan sparring.

## Facts checked in the repo

- `AWS-STAGE-DEPLOY-GATEWAY.yml` (comment near `SUPABASE_JWT_SECRET`) says staging talks to the production Supabase project. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE` come from repo secrets that point there.
- The same comment says the only Aurora cluster is `vitana-aurora-prod` (no separate staging cluster, confirmed by `aws rds describe-db-clusters` at the time it was written).
- The staging gateway reads `vitana/supabase/staging/url-aurora-proxy` (Aurora proxy URL) in the DATA_REST path, and `vitana/supabase/prod/*` for the JWT secret and anon key.
- Not verified: whether a separate Supabase staging project exists. The repo does not show one. This plan assumes it does, and step 0 below checks it.

## Scope

- VTID: VTID-05023 (cutover, option B).
- Creates: one Aurora PostgreSQL 17 cluster for staging, named `vitana-aurora-staging`, in account 472838866351, eu-central-1, with its own parameter group `vitana-aurora-pg17-staging`.
- Copies: Supabase staging data into the cluster with DMS, using the storage-auth scope from the handover (`scripts/aws/aurora-to-supabase-cdc.sh --scope storage-auth`).
- Points: the staging gateway `DATA_REST_URL` and `SUPABASE_URL` aurora mode at the staging proxy.
- Does not touch `vitana-aurora-prod`, `vitana-postgres-staging`, or any production secret.

## Steps (each is a separate change, applied in order)

0. Confirm Supabase staging exists: read `vitana/supabase/staging/url-aurora-proxy` and the staging Supabase project ref. Stop if the staging Supabase project does not exist.
1. Create the cluster (IaC or `scripts/aws/rehearsal-clone.sh`-style script; no manual console change). Enable `rds.logical_replication=1` on its parameter group before the reboot.
2. Apply the Aurora compatibility layer to the new cluster only, then the migration set (B2 list, once owner step O5 confirms it).
3. Run DMS in full-load mode, then CDC. Stop at a verified cutover point.
4. Parity: row counts and checksums per table, Supabase staging versus the new cluster, from one snapshot. Output to `docs/validation/VTID-05023/parity-staging.md`.
5. Point the staging gateway at the proxy through `AWS-STAGE-DEPLOY-GATEWAY.yml`.
6. Staging smoke test: `/api/v1/admin/health` reports `env=staging`, `/api/v1/admin/build-info` matches the deployed SHA, and the auth bridge answers 401 without a service token.

## Test plan

- Parity report with zero mismatched tables before step 5.
- Smoke test after step 5 (step 6 above).
- Rehearsal first: the same steps run on a clone named `vitana-aurora-rehearsal*` before the staging cluster is created.

## Rollback

- Switch the staging gateway back to the previous `SUPABASE_URL` through `AWS-STAGE-DEPLOY-GATEWAY.yml` with `workflow_dispatch` on the previous good SHA.
- Stop the DMS task. It stays on Supabase as the source of truth until step 5 succeeds.
- Keep the staging cluster after rollback. Delete it only in a separate, owner-approved change.

## Owner decisions this plan depends on

- O5: confirm the migration set in step 2.
- Confirm that a Supabase staging project exists (step 0).
