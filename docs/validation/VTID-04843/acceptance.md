# VTID-04843 — a fresh orb-widget cache bust

The staging frontend referenced `orb-widget.js?v=20261002-vtid-04840-commerce-setup`
before the gateway that serves the VTID-04840 widget had deployed, so the CDN
cached the older widget under that URL (`cache-control: immutable`, one year).
Measured 2026-10-02 11:11 UTC: the cached URL served a widget without
`startCommerceSetup`; the origin, asked with an uncached query, served it.

VALIDATION_PROFILE: gateway_backend

OASIS_IMPACT: no

## Acceptance criteria

AC-1: The Command Hub index.html (and vitana-v1's, in its own PR) loads `orb-widget.js?v=20261002-vtid-04843-widget-rebust`; every staging suite that names the widget version names this one (VTID-04659/04696 guards).
  TEST: services/gateway/test/vtid-04659-staging-checks-use-versioned-urls.test.ts
  TEST: services/gateway/test/vtid-04696-staging-checks-follow-asset-bumps.test.ts
AC-2: On staging, the new URL serves the widget with the commerce setup entry point.
  TEST: docs/validation/VTID-04843/staging-tests.json

## Scope

- Changed: `services/gateway/src/frontend/command-hub/index.html` (?v=), the pinned version in the VTID-04659 test and the VTID-04644/04659/04840 staging suites, the ownership-guard allowlist.
- No widget code change.
