# VTID-05129 - make the community-app full STAGING-VERIFY run green (runner + guard)

Owner Gate 1 "yes", 2026-10-13. Sparring: `plan-sparring.md` (converged, 2 rounds).
This PR is the vitana-platform half (runner + guard); the vitana-v1 half updates the stale specs.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: A dropped version-stamp sample is "unknown", never a mismatch; match needs at least half the samples readable and all readable ones on the commit; a different stamp is still a mismatch.
  TEST: scripts/ci/staging-verify/lib.test.cjs
AC-2: The after-run deploy check gets 3 attempts and its problem lists every sample.
  TEST: scripts/ci/staging-verify/lib.test.cjs
AC-3: A GET/HEAD is retried (max 2) only when fetch throws a transient network error; HTTP statuses, TLS/DNS errors and write probes are never retried.
  TEST: scripts/ci/staging-verify/lib.test.cjs
AC-4: A staging-guard failure summary names the blocked requests.
  TEST: scripts/ci/staging-verify/lib.test.cjs
AC-5: The guard tolerates the shared list of app-wide aborts (10 exact, anchored entries, cap 16); an unlisted write, a sibling path, or a production-host record still fails; a spec's own allowance still adds.
  TEST: scripts/ci/staging-verify/lib.test.cjs
AC-6: staging-guard.ts mirrors lib.cjs's list exactly and applies it.
  TEST: scripts/ci/staging-verify/lib.test.cjs
AC-7: End to end — after both PRs merge, a full STAGING-VERIFY community-app run on the served commit has 0 failures (recorded in outputs/README.md before Gate 2).
  TEST: STAGING-VERIFY.yml full=true (community-app)
AC-8: Fix-forward 1 — a "fetch failed" whose cause is a closed socket, a headers timeout, EPIPE, an unreachable network/host or an AggregateError made only of transient codes is retried; a TLS member keeps it a real failure; every network failure names its cause in the evidence.
  TEST: scripts/ci/staging-verify/lib.test.cjs
AC-9: Fix-forward 1 — the verify job's timeout fits a full community-app run (75 min; 45 cancelled proof run 38363989362 during its final deploy check).
  TEST: STAGING-VERIFY.yml full=true (community-app)
