# VTID-05672 acceptance

Claim: STAGING-VERIFY dedupes shared commands and overlaps suites (bounded by STAGING_VERIFY_JOBS).

AC-1: the pool bounds parallelism, serialises checks per directory, and isolates failures
TEST: scripts/ci/staging-verify/pool.test.mjs
Evidence: 108 unit tests pass across scripts/ci/staging-verify (commands.log, outputs/unit-tests.txt), including the 5 pool tests (limiter bound, per-key lock order, parallel keys, failure isolation).

Not yet claimed (open in the PR body): runner-level equivalence (old vs new rows), the --deploy-runs-file path, and the measured wall-time reduction, which is taken after merge on staging.
