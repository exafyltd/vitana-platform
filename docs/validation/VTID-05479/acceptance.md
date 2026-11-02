# Acceptance — VTID-05479 (mt-identity-r2 / migration-records)

Plan amendment 1 (exafyltd/vitana-platform#4624, merged be153691) added this lane. It owns the MIGRATION-QUEUE rows and the
drift-baseline entries for the identity migrations, so the four DB lanes can pass MIGRATION-DRIFT-CHECK until the owner
approves each apply.

AC-1: `docs/multitenancy/MIGRATION-QUEUE.md` has one row for each of the nine identity migration files (rows 12 to 20), in timestamp order, each with status "queued (pending owner approval)".
TEST: grep -c "^| 1[2-9] |\|^| 20 |" docs/multitenancy/MIGRATION-QUEUE.md   (expect 9)

AC-2: `scripts/ci/migration-drift-baseline.json` lists exactly the two identity tables that are declared but not yet applied (`membership_drift_reports`, `tenant_claim_mismatch_log`), count 110, and no other entry changes.
TEST: node -e "const b=require('./scripts/ci/migration-drift-baseline.json');console.log(b.count,b.known_missing_tables.length)"   (expect 110 110)

AC-3: this PR applies no migration and contacts no database or live system.
TEST: git diff --name-only origin/main...HEAD   (only docs/multitenancy/MIGRATION-QUEUE.md, scripts/ci/migration-drift-baseline.json and docs/validation/VTID-05479/)
