# VTID-05672 acceptance

Claim: STAGING-VERIFY dedupes shared commands and overlaps suites (bounded by STAGING_VERIFY_JOBS).

AC-1: the pool bounds parallelism, serialises checks per directory, and isolates failures
TEST: scripts/ci/staging-verify/pool.test.mjs
Evidence: 108 unit tests pass across scripts/ci/staging-verify (commands.log, outputs/unit-tests.txt), including the 5 pool tests (limiter bound, per-key lock order, parallel keys, failure isolation).

AC-2: a shared command runs once per verify; later suites reuse its result with reused_from, a failure is reused too, and rows keep manifest order
TEST: scripts/ci/staging-verify/run-dedupe.test.mjs
Evidence: 4 runner-level tests with real temp git repos and child processes (dedupe, distinct argv runs again, failure propagation, row order and reused_from).

Not yet claimed: a full old-vs-new row comparison (the old runner no longer exists to compare against), the --deploy-runs-file path, and the measured wall-time reduction, which is taken after merge on staging.
