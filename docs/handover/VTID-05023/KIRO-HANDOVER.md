# HANDOVER — VTID-05023: Supabase → Aurora cutover, staging and rehearsal run

Owner: d.stevanovic. Executor: one fresh Kiro session (the cutover lane).
Repos: exafyltd/vitana-platform (backend, migrations, AWS scripts), exafyltd/vitana-v1 (frontend, staging specs).
Estimated execution: 45–60 hours hands-on, plus AWS wait time. Expect 2–3 working days.

---

## 0. Scope and authority

1. **This run goes to staging and rehearsal only.** Everything in Part 3 runs without stopping. Do not wait for a human between tasks.
2. **Production is not part of this run.** No production write, deploy, migration, DNS change, security-group change or reboot. The owner decides separately, later, when to move production. Part 4 is a readiness pack only.
3. **Forbidden at all times:** testing against production; writes to the Supabase production project or to production Aurora `vitana-aurora-prod`; writes as test account `a27552a3-0257-4305-8ed0-351a80fd3701`; any secret in a file, commit, log or lane.
4. **Stop conditions (write a report, then stop that task only):** (a) the same failure survives three fix-forward attempts; (b) a security or data-loss risk; (c) a credential you do not have is required.
5. Pull requests: draft first, mark ready once checks are green, merge once checks are green. Staging deploys automatically on merge, which is allowed. Back-end work goes through a `plan(` PR so CI plan sparring can converge.

## 1. Fixed facts (do not re-derive)

- AWS account 472838866351, region eu-central-1. Every AWS call first checks the account and refuses on mismatch.
- Aurora production cluster `vitana-aurora-prod` (PostgreSQL 17.4, parameter group `vitana-aurora-pg17-prod`). Read-only for this run.
- Rehearsal target: clones named `vitana-aurora-rehearsal*` only, created by `scripts/aws/rehearsal-clone.sh` or `AWS-REHEARSAL-AURORA-CLONE.yml`. This is the only Aurora target that may be written to in this run.
- Option B scope: Aurora serves `/rest/v1` only, through the PostgREST-Aurora proxy (internal `postgrest-aurora-prod.vitana.internal:8080`; public `data.vitanaland.com` serves `/rest/v1` and `/alive`). Auth, Storage, Edge Functions and chat/voucher storage policies stay on Supabase. A full Supabase exit is a later program and is not part of this handover.
- Gateway variables: `SUPABASE_URL` points to the internal proxy after the switch; `SUPABASE_PUBLIC_URL` stays `https://inmkhvwdcuyhnxkgfvsb.supabase.co`. Repo variables: `DATA_REST_URL`, `MIGRATION_TARGET`, `MIGRATION_FREEZE`, `SUPABASE_URL_AURORA_PROXY_STAGING_ARN`.
- Already on main: auth bridge (`scripts/aws/aurora-cutover-auth-bridge.sql`, `services/gateway/src/routes/auth-bridge.ts`); reverse-CDC scripts (`scripts/aws/aurora-to-supabase-cdc.sh`, `scripts/aws/supabase-cutover-reverse-cdc-triggers*.sql`); IAM policy files and `scripts/aws/iam/vtid-05023-iam-check.sh`; rehearsal clone script (71/71 tests); Realtime service `services/realtime-aurora` (21/21); migration tooling (`aurora_sql_split.py`, `aurora-apply-migration.sh`, `aurora-pgrst-ddl-watch.sql`); `docs/validation/VTID-05023/*`.
- Open PR: exafyltd/vitana-platform #4964 (draft, head db01fec1, 24/24 checks green). Carries the manifest fixes for VTID-05331, 05504, 05506, 05507, 05609 and the 04784 retirement. Waiting on manifest-owner review.

## 2. Verify first (read-only; record in `docs/validation/VTID-05023/preflight.md`)

| # | Check | Expected | If not as expected |
|---|---|---|---|
| V1 | `aws sts get-caller-identity` | 472838866351 | stop (0.4c) |
| V2 | `aws rds describe-db-cluster-parameters` for `rds.logical_replication` on the rehearsal clone | value recorded | record |
| V3 | ECS services for the staging proxy and staging Realtime | exist or absent | absent = create in Phase C |
| V4 | DMS instance `PHZCRFHVT5ENVI4H4NMGWBXSEI`; tasks `vitana-cdc-aurora-to-supabase-*` | state recorded | record; do not start |
| V5 | `vtid-05023-iam-check.sh <deploy-role>` | missing actions listed | list in lane for owner |
| V6 | `scripts/cutover/verify-cutover.sh` on GitLab branch `gitlab-migration-prep` | file readable | record |
| V7 | Migration list: 12 or 13 files | confirmed list | see Phase B |
| V8 | Supabase read-only `select 1` | reachable | record |
| V9 | GitHub freeze state on main | recorded | record |

## 3. Execution (staging and rehearsal) — do all of it, in order

### Phase A — Staging gate (blocks everything)

- **A1. Fix the 12 failing staging gate tests:** 04880, 04887, 04975, 04984, 04999, 05003, 05004, 05064, 05069, 05071, 05277, 05281. Reproduce each locally, paste the exact output into the lane file, then fix the code or the wrong test. Never skip, disable or loosen a test. Acceptance: STAGING-VERIFY green on one commit.
- **A2. Track PR #4964** until the manifest owners merge it. Do not mark it ready yourself.

### Phase B — Aurora compatibility

- **B1. Lint:** fail any `supabase/migrations/*.sql` that references `auth.*`, `storage.*`, Supabase-only roles, or extensions Aurora lacks. Wire it into PR-GATE. Test with one passing and one failing fixture.
- **B2. Run the lint over the 12/13 migrations.** Fix every flagged file so it applies unchanged to Aurora (use `auth_user_fk_map`, not `auth.users`). Each migration stays idempotent. Do NOT touch the held drop `20261102052300_vtid_05573_legacy_messages_drop.sql`; it is excluded from every apply list.
- **B3. Local proof:** run the PGlite/pgTAP harness (`docs/validation/VTID-05507/pglite-harness`) over the full set, in order. Record the results.

### Phase C — Staging and rehearsal infrastructure

- **C1. Rehearsal clone:** `scripts/aws/rehearsal-clone.sh create` (resumes a half-built clone; refuses untagged clusters). Acceptance: clone available, Data API enabled, managed secret present.
- **C2. Parameter group on the rehearsal clone only:** set `rds.logical_replication=1` on the clone's parameter group, reboot the clone (not production), wait until available.
- **C3. Migrations on the rehearsal clone:** apply the B2 set in order through `aurora-apply-migration.sh`. Record each file's result. Stop the chain at the first error and follow 0.4a.
- **C4. Parity on the clone:** row counts and checksums of the 5 storage-auth tables and the rest of `public`, Supabase versus clone, from one fixed snapshot. Write `docs/validation/VTID-05023/parity-rehearsal-1.md`.
- **C5. Staging proxy:** create or update the staging PostgREST-Aurora proxy through `AWS-PROD-DEPLOY-POSTGREST-AURORA-PROXY.yml` with staging inputs. Staging only.
- **C6. Staging Realtime:** deploy the Aurora Realtime service to staging. If the port-4000 security-group rule is missing, record the exact command in the lane and continue with the rest.
- **C7. DMS, storage-auth scope:** `scripts/aws/aurora-to-supabase-cdc.sh --scope storage-auth --apply` creates the endpoints and the task, and does NOT start it. Run `aws dms test-connection` on both endpoints. Do not start the task in this run.
- **C8. DMS, rollback scope:** same script with `--scope rollback`. Created, not started.
- **C9. Reverse trigger script:** test `scripts/aws/supabase-cutover-reverse-cdc-triggers.sql` and its rollback on the local fixture (`scripts/aws/test/reverse-cdc.sh`). Do not run it against any Supabase project in this run.

### Phase D — Gateway wiring and staging switch

- **D1. Staging task definition:** read the live task definition first, then point `SUPABASE_URL` at the staging proxy secret (`vitana/supabase/staging/url-aurora-proxy`) using `scripts/aws/taskdef-data-backend.py` and the workflow's `data_backend=aurora` input.
- **D2. Staging DB REST:** set repo variable `DATA_REST_URL` for staging only. Merge, then run STAGING-VERIFY against that exact commit.
- **D3. Auth bridge:** confirm `POST /api/v1/internal/auth-bridge/user-event` answers 401 without the service token; the probe is in `staging-tests.json`.
- **D4. Frontend (vitana-v1):** if a staging spec needs changing, use the `frontend-simple` class. Read-only staging specs only.

### Phase E — Second rehearsal and readiness pack

- **E1. Second full rehearsal** from a fresh clone: repeat C1→C4 and D1→D3. The second run must be clean. Record `docs/validation/VTID-05023/rehearsal-2.md`.
- **E2. Readiness pack (no production action):** `docs/validation/VTID-05023/window-runbook.md` with the ordered commands for Part 4, the `verify-cutover.sh` result, the parity report, and the rollback commands. Lists every owner step.

## 4. Production — readiness only, NOT part of this run

Nothing here is executed in this run. Kiro writes it into the runbook in E2 and stops there. The owner decides separately when production moves. For reference, the runbook covers: the Aurora parameter change and reboot; production migrations through `RUN-MIGRATION.yml` with `MIGRATION_TARGET=aurora`, one file per dispatch, owner-confirmed list, held drop excluded; the window (GitHub freeze, final sync verified by `verify-cutover.sh`, Aurora final copy, DMS start, gateway deploy pinned to the verified commit, DB REST switch, build-info check, two-hour watch); and rollback (switch DB REST back first, then the gateway, then stop DMS and run the reverse trigger rollback).

## 5. Owner steps (Kiro records these as blockers; it does not wait on them)

| ID | Step | Why owner |
|---|---|---|
| O1 | Run `vtid-05023-iam-check.sh` in CloudShell; attach the listed policies | IAM admin |
| O2 | Add GitLab OIDC trust to the AWS roles | IAM admin |
| O3 | Port-4000 security-group rule `sg-0fbcf7b59b1f0d685` | network change |
| O4 | Create the Cloudflare token (DNS + WAF on vitanaland.com) | credential |
| O5 | Confirm the migration list | schema decision |
| O6 | Revoke the token that was exposed in chat | credential |

## 6. GitLab

- G1. Read `scripts/cutover/verify-cutover.sh` from `gitlab-migration-prep` in `vitana/vitana-platform`.
- G2. Confirm MR !8 (reported merged, merge commit `40a053e6`). Record the result; do not assume it.
- G3. Add the missing CI variables for staging: `DATA_REST_URL` (staging) and the staging proxy URL. The Supabase database URL is stored masked and protected, never in a file.

## 7. Failure policy

- Same failure after three fix-forward attempts: stop that task, record the exact output, and continue with any task that does not depend on it.
- Do not claim done without the artifact that proves it: test output, parity file, or a STAGING-VERIFY run link.
- Do not mark any check green from memory.

## 8. Evidence and reporting

- Lane file: `docs/validation/VTID-05023/lane.md`: claims, progress, blockers, commit SHAs, command outputs.
- Final report to the owner when Phases A–E are done or blocked: a table with every task ID, its status, its evidence link, and the owner steps still open.

## 9. What done means for this run

1. Phases A–E are done, with evidence, or blocked with the exact output.
2. The staging gate is green on one commit, and the rehearsal evidence exists.
3. The readiness pack exists. Production has not been touched.

Production cutover is a separate owner decision after this run.
