# VTID-04660 — Command Hub loads the widget at a new version

## Report

VTID-04644 changed `orb-widget.js` without a new `?v=`. The gateway serves the widget with `Cache-Control: public, max-age=31536000, immutable`, and Cloudflare caches per URL, so the Command Hub's `?v=20260925-vtid-04587-thinking` kept serving the widget from before VTID-04644 (the after-turn branch is missing, measured on staging). That is why STAGING-VERIFY gateway @ c7f2c06 failed. The member app gets its own new version in vitana-v1 #1178 and the gateway check is repointed in #3768 (VTID-04658). This change gives the Command Hub a new version too.

## Acceptance

AC-1: The Command Hub page loads `orb-widget.js?v=20260926-vtid-04660-after-turn`, and the widget at that URL on staging contains the VTID-04644 after-turn branch.
TEST: services/gateway/test/command-hub/

AC-2: The Command Hub static and cache-header suites stay green.
TEST: services/gateway/test/routes/command-hub-static-cache-headers.test.ts

OASIS_IMPACT: no
