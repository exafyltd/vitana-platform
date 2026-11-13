# VTID-05784 — autonomous-to-staging-r2, lane `staging-migrations-auto`

Plan `.kiro/specs/autonomous-to-staging-r2/plan.md` §3.5 ("as r1 §3.4 … its `target: staging` resolves only to
`vitana-aurora-staging` with `vars.AWS_STAGING_DB_ROLE_ARN`"), r1 plan `.kiro/specs/autonomous-to-staging/plan.md` §3.4,
tasks T1–T3 of the r1 lane block, decision record `design.md` §2, §4, §6, §8. Session `kiro-exafy-202611110920-270b`.
Owner directive 2026-11-12: *"approval to revise and validate the plan, not approval to incur infrastructure costs or
execute the database provisioning and cutover"*; *"Do not switch staging away from its current authentication or
database configuration until a safe, reversible transition is demonstrated."*
This lane is code, tests and docs only: no AWS call was made, nothing was dispatched, no migration was applied to any
database, no secret was read or written, no production credential or role was used. Everything it adds is OFF until the
owner-set repository variables of the stage-2/3 lanes say otherwise; this lane adds no variable.

## What changed
- `scripts/aws/staging-db-apply-migration.sh` (T1): applies migration files to a staging cluster over the RDS Data API.
  `--cluster` required, no default; `staging-db-common.sh` `sdb_check_cluster` refuses any name containing `prod` and any
  name other than `vitana-aurora-staging[-<suffix>]` before any AWS call (no override). Then: account `472838866351` and
  `eu-central-1`; caller must be `assumed-role/vitana-gha-staging-db/*` (the role of `design.md` §4); cluster ARN, tag
  `vitana-env=staging` and RDS-managed master secret. Several `--file`: ONE transaction for the whole batch, all or
  nothing. `--dry-run` (no AWS), `--allow-non-transactional` (one file only), `--read-only` (always rolled back).
  Retries while the Data API is enabled or the auto-paused cluster resumes (`design.md` §2 option A).
- `scripts/aws/staging-db-migrate-gate.sh`: the default-off, fail-closed gate (no AWS call). Off unless
  `STAGING_DATA_PLANE=isolated`; then `AWS_STAGING_DB_ROLE_ARN` must be exactly
  `arn:aws:iam::472838866351:role/vitana-gha-staging-db`, `STAGING_DB_COST_APPROVED=yes`, ref `refs/heads/main`;
  `MIGRATION_FREEZE=true` and unknown plane values refuse. Mode `auto` (push): off = notice, exit 0; mode `dispatch`:
  off = refused.
- `scripts/aws/staging-db-migrate.sh` (T2 steps): `files` (migration files ADDED between two commits, timestamp order;
  modified/deleted files never re-applied; replay-skipped files left out like the schema bundle), `snapshot`
  (pre-apply snapshot `vitana-aurora-staging-premig-<run>-<attempt>`, tagged), `compat` (read-only probe of every object
  the STAGING-VERIFY gateway smoke reads), `quarantine-check` (machine quarantine from the run history).
- `.github/workflows/STAGING-MIGRATE.yml` (T2): push to `main` on `supabase/migrations/**`, dispatch (catch-up
  `base_sha`, `acknowledge_quarantine_run`), and pull requests that change this lane's files (self-test only, no
  credentials). Jobs: `gate` → `plan` (files, lint, schema bundle of the commit; no AWS) → `apply` (guard, gate again,
  OIDC `vars.AWS_STAGING_DB_ROLE_ARN`, snapshot, apply, drift check = `staging-db-load.sh --verify-only` against the
  bundle of the commit, compatibility probe, evidence artifact) → `quarantine` on failure. No schedule.
- `.github/workflows/RUN-MIGRATION.yml` (T1): option `staging` and job `migrate-staging`, in `# >>> VTID-05784` blocks
  only. Outside them the file is the origin/main file byte for byte (pinned copy `fixtures/RUN-MIGRATION.pinned.yml`).
- Tests `tests/staging-migrate.test.mjs` with stub CLIs `fixtures/bin/{aws,gh}`; the stub's Data API is a local
  Postgres (PGlite) with real transaction semantics. They run in STAGING-MIGRATE.yml job `selftest`.
- `scripts/aws/aurora-apply-migration.sh` (production) is not changed.

## Acceptance criteria → tests

AC-1 Target `staging` never resolves to a production cluster, project ref or `AWS_PROD_ROLE_ARN`: `staging-db-apply-migration.sh` without `--cluster` fails (usage, exit 2), with the production cluster fails (exit 1), both before any AWS call and with no override; any non-staging name fails the same way; credentials other than the staging database role, another account, a cluster not tagged `vitana-env=staging`, a foreign cluster ARN or no managed secret refuse before any Data API call.
TEST: docs/validation/VTID-05784/tests/staging-migrate.test.mjs ("apply: without --cluster it fails (usage) before any AWS call"; "apply: the production cluster is refused before any AWS call, also as a dry run (no override exists)"; "apply: any non-staging cluster name is refused before any AWS call"; "apply: credentials other than the staging database role are refused before any cluster or Data API call"; "apply: wrong account, untagged cluster, foreign cluster ARN or no managed secret are refused; no Data API call"; "apply --dry-run prints the plan for the staging cluster and makes no AWS call")
TEST: docs/validation/VTID-05784/tests/staging-migrate.test.mjs ("guard: the new staging scripts name no production identifier (--enforce)"; mutations "removing a guard of the apply script is caught" (a) cluster check, (b) caller role, (c) tag)

AC-2 Rollback is proven with a failing fixture migration on a local Postgres: a batch whose second file fails leaves nothing applied (the good first file is rolled back too), commit is never called; a good batch commits once in order; `--read-only` never keeps anything; a resuming cluster is retried.
TEST: docs/validation/VTID-05784/tests/staging-migrate.test.mjs ("rollback: a failing fixture migration rolls the whole batch back on Postgres (nothing applied, no commit)"; "rollback: a good batch is committed once, in order, then NOTIFY pgrst"; "rollback: a resuming (auto-paused) cluster is retried, then applied"; "read-only: --read-only always rolls back (the compatibility probe never keeps anything)"; mutation (d) "a failed statement no longer aborts the batch")

AC-3 Default off and fail closed: nothing is applied unless `STAGING_DATA_PLANE=isolated`, the staging database role, cost approval and main; unknown plane values, a wrong role ARN, a missing approval, another ref or `MIGRATION_FREEZE=true` refuse; a dispatch to target staging while the plane is shared is refused.
TEST: docs/validation/VTID-05784/tests/staging-migrate.test.mjs ("gate: unset or shared plane = off (auto: notice, exit 0, enabled=false; dispatch: refused); no AWS call"; "gate: isolated is enabled only with the staging database role, cost approval and main; anything else refuses"; "mutations: removing a gate guard is caught"; "apply: MIGRATION_FREEZE=true refuses before any AWS call"; mutation (e) freeze)

AC-4 STAGING-MIGRATE on merge (T2): migration files added on main, in timestamp order; lint before credentials; snapshot → apply (one transaction, never non-transactional) → drift check → compatibility probe, in that order, every step unconditional; quarantine on any apply failure (red run, restore plan recorded), later automatic applies refused until a dispatch acknowledges exactly the failed run; only `vars.AWS_STAGING_DB_ROLE_ARN`, only `vitana-aurora-staging`, no repository secret, no production role or cluster, no schedule, pull requests run only the self-test without credentials.
TEST: docs/validation/VTID-05784/tests/staging-migrate.test.mjs ("files: only migration files ADDED on main, in timestamp order; modified and replay-skipped files are not applied"; "snapshot: a tagged snapshot of the staging cluster only, before anything is applied"; "compat: passes when every object the gateway smoke reads is there; fails (and keeps nothing) when one is missing"; "quarantine: a failed earlier apply blocks automatic applies until a dispatch acknowledges exactly that run"; "STAGING-MIGRATE.yml: default off, staging role and cluster only, snapshot -> apply -> drift -> compat, quarantine; no schedule"; "mutations: every STAGING-MIGRATE.yml guard has a failing mutation" — 16 mutations)

AC-5 RUN-MIGRATION.yml's production path is unchanged: outside the `# >>> VTID-05784` blocks the file equals the pinned origin/main copy byte for byte; jobs `migrate` and `migrate-aurora` are byte-identical; the resolve step resolves every production input (target × MIGRATION_TARGET × MIGRATION_FREEZE, 50 combinations) exactly as the pinned step; `MIGRATION_TARGET` can never select staging; target staging runs a separate job with the gate before the credentials, the staging database role only and the staging script only.
TEST: docs/validation/VTID-05784/tests/staging-migrate.test.mjs ("RUN-MIGRATION.yml: the production path is the pinned origin/main file byte for byte; staging is a separate job"; "RUN-MIGRATION.yml resolve: every production input resolves exactly as the pinned step; staging only when chosen"; "mutations: every RUN-MIGRATION.yml guard has a failing mutation" — 9 mutations; "aurora-apply-migration.sh (production script) is unchanged by this lane")

AC-6 Evidence per run (T3): each apply run uploads `staging-migrate-evidence-<run id>` (`evidence.json`: run URL, commit, cluster, snapshot id, expected schema hash of the bundle, files, outcome) and, on failure, `staging-migrate-quarantine` (`quarantine.json`: snapshot id, how to lift, restore as an owner action).
TEST: docs/validation/VTID-05784/tests/staging-migrate.test.mjs ("STAGING-MIGRATE.yml: default off, …" asserts the evidence and quarantine steps run on `always()` / `failure()`, and the snapshot id format)

Results: 27 tests, 27 pass with PGlite (outputs/green.txt); 21 pass + 6 skipped without PGlite (outputs/green-no-install.txt;
the selftest job fails a run that skips); on origin/main + these tests: 26 fail, 1 pass (outputs/red-on-base.txt).
Existing suites unchanged: `node --test scripts/ci/staging-db/*.test.mjs scripts/ci/workflow-trigger-check.test.mjs` 191/191;
gateway Jest workflow scanners 9 suites, all pass except `loop-catalog.test.ts`, which fails identically on origin/main
(orphan `AWS-KIRO-ACCESS`, not this lane). Guard: `--report` unchanged at 35 references (outputs/guard-report.txt);
`--enforce` over this lane's workflow and scripts: 0 (outputs/guard-enforce.txt).
Not verified on staging: nothing deploys (no gateway or frontend deploy path; STAGING-TESTS-REQUIRED needs no suite)
and nothing may be applied before the owner actions below; covered by the stub/PGlite tests.

## Decisions taken
1. **Rollback = one transaction per batch.** The staging database role (`design.md` §4, `infra/staging-db/stack.yaml`) may
   create a cluster snapshot but cannot restore or delete a cluster (DenyDelete; no `rds:Restore*`), and changing the
   stack is not in this lane. So the automatic rollback of a failed apply is the transaction: every added file of the
   merge in one Data API transaction, rolled back whole on any failure (proven on Postgres). The pre-apply snapshot is
   still taken; when the drift check or the compatibility probe fails AFTER the commit, the run quarantines and records
   the snapshot id; restoring from it is an owner action (or a fix-forward migration). A non-transactional file is never
   applied automatically: it goes through RUN-MIGRATION target staging, alone.
2. **Compatibility suite = read-only probe of the objects the STAGING-VERIFY gateway smoke reads**
   (`build-schema.mjs` `SMOKE_OBJECTS`), via the Data API in a rolled-back transaction. The r1 wording "gateway Jest DB
   tests against the cluster" cannot run from a GitHub runner: the cluster is VPC-private and the runner reaches it only
   through the Data API (`aurora-apply-migration.sh` header). Behaviour against the isolated data stays with
   STAGING-VERIFY after the staging deploy.
3. **Drift check = cluster schema hash vs. the schema bundle built from the same commit** (`staging-db-load.sh
   --verify-only`, existing code), not `MIGRATION-DRIFT-CHECK.yml`, which reads production.
4. **Enabled by `STAGING_DATA_PLANE=isolated`** (the variable the cutover lane flips), plus the stage-2 variables
   `AWS_STAGING_DB_ROLE_ARN` (exact role ARN) and `STAGING_DB_COST_APPROVED=yes`. No new variable. The r1 name
   `AWS_STAGING_MIGRATION_ROLE_ARN` is replaced by `vars.AWS_STAGING_DB_ROLE_ARN` as r2 §3.5 says.
5. **Only ADDED migration files are applied;** an edited or deleted migration is never re-applied (its effect shows in
   the drift check). Files merged while staging migrations were off are applied by a dispatch with `base_sha`.
6. **Quarantine without a live write:** the quarantine is read from the workflow's own run history (actions: read) and
   lifted by a dispatch that names the failed run. No OASIS event and no lane-file write from the workflow (both would
   need write credentials); the red run and its `staging-migrate-quarantine` artifact are the record.
7. **Evidence per run is a workflow artifact** (`evidence.json`), not a commit: the workflow has `contents: read`. The
   lane's closing record copies the first real run's evidence into this directory.
8. **Tests live in this evidence directory and run in STAGING-MIGRATE.yml `selftest`:** the lane's paths do not include
   `scripts/ci/**`, which UNIT.yml scans.

## Owner actions (none needed for this PR; each is the existing stage-2/3 action)
Before anything is applied: `STAGING_DB_COST_APPROVED=yes`, the stack applied and `AWS_STAGING_DB_ROLE_ARN` set
(`design.md` §6.1–§6.2), the schema loaded (AWS-STAGE-PROVISION-DB mode load), and `STAGING_DATA_PLANE=isolated` set by
the cutover (§6.3). Until then STAGING-MIGRATE prints a notice on every migration merge and applies nothing.
