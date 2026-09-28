# VTID-04659 — the VTID-04644 widget change reaches the Command Hub and the community app

STAGING-VERIFY gateway @ c7f2c06 failed on one check:
`VTID-04644 › http /command-hub/orb-widget.js — body does not contain "msg.after_turn === true"`.
The source on `main` contains it. The served widget did not, because:

- `/command-hub/*.js` is served `public, max-age=31536000, immutable` (VTID-04074) and
  Cloudflare keeps each URL for a year; a new build is reached only through a new `?v=`.
- VTID-04644 changed `orb-widget.js` and bumped no `?v=`, so the Command Hub
  (`?v=20260925-vtid-04587-thinking`) and the community app
  (`?v=20260925-vtid-04560-view-role`, exafyltd/vitana-v1) kept serving the widget cached
  before the change. The fix never reached a user, and would not have reached production.
- The VTID-04644 check read the bare URL, which Cloudflare cached on 2026-09-25 19:57 and
  never refreshes. Probe: `outputs/staging-widget-cache-probe.txt` (every cached URL
  lacks the marker, a fresh URL has it).

## Acceptance criteria

AC-1: The Command Hub loads `orb-widget.js?v=20260926-vtid-04659-after-turn`.
  TEST: services/gateway/test/vtid-04659-staging-checks-use-versioned-urls.test.ts
AC-2: No staging http check reads a Command Hub asset that index.html loads with `?v=`
  at its bare URL; the VTID-04644 and VTID-04626 checks read the URL the page loads.
  Mutation-checked: restoring the bare VTID-04644 path fails it, reverting the index.html
  bump fails AC-1.
  TEST: services/gateway/test/vtid-04659-staging-checks-use-versioned-urls.test.ts
AC-3: `.js` assets stay immutable (the cache contract this relies on is unchanged).
  TEST: services/gateway/test/routes/command-hub-static-cache-headers.test.ts
AC-4: The Command Hub symbol index matches the widget VTID-04644 changed.
  TEST: services/gateway/test/scripts/generate-command-hub-symbol-index.test.ts
AC-5: On staging, the page and the versioned widget URL serve the change
  (`staging-tests.json`, run by STAGING-VERIFY after the deploy).
  CURL: https://preview-aws-gateway.vitanaland.com/command-hub/orb-widget.js?v=20260926-vtid-04659-after-turn

The community app half is exafyltd/vitana-v1 (same VTID): its index.html preload and
script tags move to the same `?v=`.

## Not verified here

Voice navigation itself (VTID-04644's behaviour) needs a spoken session; this change only
makes the new widget reach the browser.

OASIS_IMPACT: none — static asset URL and test data only; no event, route or schema change.
