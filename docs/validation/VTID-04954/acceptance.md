# VTID-04954 — Supplier review page usability fixes

Owner report 2026-10-07 on /command-hub/partner-review.html (VTID-04933): the page could not be scrolled, a successful
Approve showed no visible confirmation (it was clicked twice), and an expired sign-in showed a bare UNAUTHENTICATED.
Frontend only; no API or data change.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: none (static Command Hub page /command-hub/partner-review.html).

FINAL_URL: https://preview-aws-gateway.vitanaland.com/command-hub/partner-review.html (staging, read-only)

CURL_PROOF: after the merge's staging deploy, the page, its stylesheet and its script are served with the new body class, the scroll override and the sign-in messages (STAGING-VERIFY, docs/validation/VTID-04954/staging-tests.json).

OASIS_PROOF: n/a (frontend only).

## Acceptance criteria

AC-1: The page scrolls: it overrides the shared styles.css body lock for itself only (body.pr-page), and the shared stylesheet is unchanged.
  TEST: services/gateway/test/command-hub/vtid-04954-partner-review-page.test.ts
AC-2: Every button in the detail panel is disabled while an action runs, so an action cannot be sent twice.
  TEST: services/gateway/test/command-hub/vtid-04954-partner-review-page.test.ts
AC-3: The outcome of an action is shown in a sticky status bar (role=status) that names what happened.
  TEST: services/gateway/test/command-hub/vtid-04954-partner-review-page.test.ts
AC-4: The page reads only the Command Hub token; a missing token and an expired one (401) each get a plain message with a link to the Command Hub, for the list, the detail and every action.
  TEST: services/gateway/test/command-hub/vtid-04954-partner-review-page.test.ts
AC-5: The page stays CSP-compliant (no inline script or style, no HTML strings) and is cache-busted for this change.
  TEST: services/gateway/test/command-hub/vtid-04954-partner-review-page.test.ts
AC-6: On staging after merge the page and its assets carry the fixes.
  UI: https://preview-aws-gateway.vitanaland.com/command-hub/partner-review.html
