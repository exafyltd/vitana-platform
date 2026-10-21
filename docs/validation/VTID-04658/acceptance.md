# VTID-04658 — the VTID-04644 staging check fetches the widget the app actually loads

VTID: VTID-04658
VALIDATION_PROFILE: gateway_backend

## Why

STAGING-VERIFY gateway @ c7f2c06 failed on VTID-04644's `http /command-hub/orb-widget.js` check
(`body does not contain "msg.after_turn === true"`). The gateway serves the new widget, but it
sends it with `Cache-Control: public, max-age=31536000, immutable`, and Cloudflare caches per URL.
The unversioned URL is a 19.5 h old cache hit. The same holds for the version the app loads
(`?v=20260925-vtid-04560-view-role`), so members on staging still got the old widget. The fix for
members is vitana-v1 #1178 (new `?v=`). This PR points the gateway check at that version.

## Acceptance

AC-1: the VTID-04644 gateway check fetches `/command-hub/orb-widget.js?v=20260926-vtid-04658-after-turn` and the manifest validates.
  TEST: docs/validation/VTID-04658/outputs/manifest-and-fetch.txt
AC-2: on staging that URL returns 200 with the after_turn branch.
  CURL: curl -s "https://preview-aws-gateway.vitanaland.com/command-hub/orb-widget.js?v=20260926-vtid-04658-after-turn" | grep -c "msg.after_turn === true"
