# VTID-04651 — Community Autopilot: read-only staging suite for the whole program

The Staging Verification Gate (rules 46–50, VTID-04610) needs a suite that proves the
Community Autopilot works on the deployed staging commit. CA-0..CA-9 and their fixes
(VTID-04523, VTID-04530) predate the gate and had none.

## What the suite checks (`staging-tests.json`)
- The recommendations service is up.
- The lineup, badge count and history answer from their own member gate
  (`UNAUTHENTICATED`), never from the pipeline's service-token gate. This is the
  VTID-04530 regression: on the broken build these answered `invalid service token`
  and every member's pop-up showed "Fetch failed: 401". The check fails on that build.
- Every write path refuses an unauthenticated caller: activate, draft, snooze, reject,
  complete, the scan tick, reminder Mark-done (closes a linked Autopilot slot), invite claim.
- The public invite lookup answers; the own-invite and supervisor views need a login.
- `npm run test:community-autopilot`: the 14 unit/integration suites that run the real
  code of every write step (activation, drafts, scans, cap, invites/credit, calendar,
  template retirement), which staging cannot exercise without writing to production data.

Nothing in the suite writes. No suite targets production.

VTID: VTID-04651
VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: The manifest validates against the STAGING-VERIFY schema and every http test passes on staging.
TEST: services/gateway/test/vtid-04530-autopilot-recommendations-not-behind-service-token.test.ts

AC-2: The 14 Community Autopilot suites pass through the new npm script.
TEST: services/gateway/test/vtid-04650-community-autopilot-template-retirement.test.ts

OASIS_PROOF: none. Test manifest and npm script only.

## Evidence
- `outputs/staging-http.txt` — 15/15 http checks pass on staging.
- `outputs/jest-community-autopilot.txt` — 14 suites, 242 tests.
