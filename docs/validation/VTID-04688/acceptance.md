# VTID-04688 — STAGING-VERIFY reads the whole response body

## Problem

`scripts/ci/staging-verify/run.mjs` kept only the first 1,000,000 characters of
every HTTP response. The Command Hub `app.js` is 2,518,880 characters, and the
two functions VTID-04661 checks for sit at offsets 1,197,696 and 1,198,949. So
STAGING-VERIFY gateway @ 682bb2a (run 36418215137) failed with "body does not
contain" for code staging really serves: a false failure that blocks the ready
message for every later commit whose range includes VTID-04661.

## Acceptance

AC-1: a body check finds a marker placed after the first megabyte.
  TEST: scripts/ci/staging-verify/lib.test.cjs › a body check finds code served past the first megabyte
AC-2: the cap is large enough for every Command Hub asset (≥ 8,000,000).
  TEST: scripts/ci/staging-verify/lib.test.cjs › the body cap is large enough for every Command Hub asset
AC-3: a body that hits the cap is reported as cut off, never as a plain miss.
  TEST: scripts/ci/staging-verify/lib.test.cjs › a body past the cap is reported as cut off, not as a plain miss
AC-4: the runner reads bodies through `clipBody`, never a fixed `.slice()`.
  TEST: scripts/ci/staging-verify/lib.test.cjs › the runner reads response bodies through clipBody, never a fixed slice
AC-5: on staging, both VTID-04661 markers are found in the real served app.js.
  CURL: docs/validation/VTID-04688/staging-tests.json

Mutation check: with the cap set back to 1,000,000, AC-1 and AC-2 fail (18/20).

OASIS_IMPACT: none — CI runner only; no gateway code, route, event or schema change.
