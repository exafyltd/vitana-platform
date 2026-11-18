# VTID-05803 acceptance: staging data migration around the DMS full load (MR !69)
Status: implemented and tested locally. Not yet executed on vitana-aurora-staging (no execution evidence yet). Production is not touched.
Scope: scripts/aws/staging-db-{vector-preload,vector-postload,restore-saved,vector-report}.sql, staging-db-migration.sh,
staging-db-vector-postload.sh, aurora-cutover-embedding-backfill.py (--cluster), schema-restore-package/{run-staging.sh,load-stages.sh,README.md,SHA256SUMS},
scripts/ci/staging-db/vector-postload.test.mjs.

AC-1 Pre-load makes the DMS TRUNCATE_BEFORE_LOAD possible. In one transaction it saves the public FKs, the views on
vector columns (with options, grants and comment) and the vector indexes to migration_audit, drops them, and stages
the 13 vector columns as text. If a policy or trigger uses a vector column, it stops and changes nothing.
TEST: "full staging cycle: pre-load lets the DMS truncate-and-load run; post-load restores exactly what was there, without the public -> auth FK"; "pre-load and restore: all or nothing — a policy on a vector column stops the pre-load; restore refuses before the vector post-load"

AC-2 Vector post-load: text back to vector(<dims>). Every incomplete value is kept verbatim in
migration_audit.vector_incomplete. Rows, keys and other columns are preserved. It runs all or nothing and can be re-run.
TEST: "post-load: casts every staged column back, keeps every incomplete value, preserves rows and keys, builds the 9 indexes"; "post-load: a second run changes nothing (re-runnable); a column that is already vector is skipped"; "post-load: all or nothing — a missing column, a dependent view or a missing extension changes nothing"; "post-load: NOT NULL is kept when a NOT NULL column has only complete values"

AC-3 The restore puts back exactly what was saved: indexes, FKs (same definition, NOT VALID) and views (definition,
options, grants, comment), shallowest view first.
TEST: "full staging cycle: pre-load lets the DMS truncate-and-load run; post-load restores exactly what was there, without the public -> auth FK"

AC-4 R2: no public -> auth.users FK on staging Aurora at any stage.
- Restore: excluded by r2-exclude-auth-users-fks.sql.
- Pre-load: recorded with references_auth=true and never restored.
- Post-load: any FK that appears later is dropped and recorded, and 0 is asserted.
TEST: "restore: a public -> auth FK the pre-load never saw (migration replay) is recorded and dropped"; "full staging cycle: pre-load lets the DMS truncate-and-load run; post-load restores exactly what was there, without the public -> auth FK"

AC-5 Order and target. Pre-load runs before the load; post-load runs the vector post-load, then the restore. This holds
on both execution paths:
- the package task: run-staging.sh STAGE=pre-load|post-load|report, through load-stages.sh;
- the Data API: staging-db-migration.sh.
Production and other hosts are refused before any database or AWS call, and secrets are redacted.
TEST: "migration sequence: refuses production before any AWS call; --plan shows pre-load, then post-load in order"; "package load-stages: refuses production, other hosts and unknown stages before psql runs"; "package load-stages: pre-load, then post-load in order, each file one transaction; a failure stops and exits 2; secrets redacted"; "package load-stages: report runs each SELECT inside a read-only transaction that is rolled back"

AC-6 Integrity. The package SHA256SUMS covers load-stages.sh and the four SQL files, and 22/22 pass. The new files have
no production references (staging-prod-ref-guard --enforce).
TEST: "package: SHA256SUMS covers the stage runner and the four SQL files it runs, and every checksum matches"; "static: the post-load never truncates, deletes, reloads or references auth, and runs in one transaction"

PROOF: outputs/vector-postload-tests-pglite.txt (15/15), outputs/vector-postload-tests-unit.txt, outputs/unit-all.txt, outputs/migration-plan.txt, outputs/package-sha256sums.txt.
Not verified on staging: the live run on vitana-aurora-staging is pending. Its evidence goes to outputs/ as load-report.out.
