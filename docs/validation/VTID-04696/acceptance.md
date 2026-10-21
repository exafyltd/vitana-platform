# VTID-04696 — staging suites follow Command Hub asset bumps

STAGING-VERIFY replays the change suite of every commit between production and
the verified commit. The VTID-04661 suite asserted the Command Hub loads
`app.js?v=20261017-vtid-04661`; VTID-04663 bumped it to `20261018-vtid-04663`,
so every gateway verification after that failed on a check about code that is
still there. VTID-04626 and VTID-04644 also named superseded versions.

The three suites now name the version index.html loads (every asserted string
was checked against the current source first), and a guard test fails the PR
that bumps an asset without updating the suites that name it.

## Acceptance

AC-1: every asset version named in a staging suite equals the one index.html loads; the guard fails on the old suites (verified by restoring them).
TEST: services/gateway/test/vtid-04696-staging-checks-follow-asset-bumps.test.ts

AC-2: no staging check reads a versioned asset at its bare URL (VTID-04659 rule unchanged).
TEST: services/gateway/test/vtid-04659-staging-checks-use-versioned-urls.test.ts

AC-3: STAGING-VERIFY gateway passes the VTID-04661 checks after deploy.
TEST: scripts/ci/staging-verify/run.mjs
