# VTID-05001 — ORB widget honours the WebSocket kill switch and records why the overlay closes

Plan C of the 2026-10-08 follow-ups to VTID-04934. Plan sparring record: `plan-sparring.md` (converged, 2 rounds, owner-approved).

Evidence that motivated it (read-only, production `oasis_events`):
- Prod has told the widget `transport:"sse"` since 2026-10-07 09:47 UTC, yet a real member still started WebSocket sessions afterwards (2026-10-07 10:43, 13:50, 15:05 and 2026-10-08 13:17 UTC; all `ws_stop_session`, 0 user turns). The compiled default `transport: 'ws'` won whenever `GET /live/transport` had not answered.
- The overlay-close event `orb.session.continuity.persisted` only ever said `reason:"hide"`, so the 2026-10-04..07 failure (overlay closed ~1.3 s after the tap, before `session_started`) could not be traced to a caller.

AC-1: The widget's compiled default transport is `sse`. WebSocket is used only for an explicit server answer `ws`, or the developer override; the per-tab fallback latch still wins over a server `ws`.
TEST: services/gateway/test/orb/vtid-05001-orb-hide-reasons.test.ts
TEST: services/gateway/test/orb/live/ws-transport-default.test.ts

AC-2: Every `_hide` call passes an allowlisted string-literal reason, and `_hide` is never used as a bare callback (checked on the parsed AST with espree; a bare `_hide()` fails the test with its line — mutation-checked).
TEST: services/gateway/test/orb/vtid-05001-orb-hide-reasons.test.ts

AC-3: `_hide` captures the diagnostics (reason, ms since tap, transport, start phase) before flushing the tap timeline and sends them with the continuity POST; a missing or unlisted reason reports `unknown`.
TEST: services/gateway/test/orb/vtid-05001-orb-hide-reasons.test.ts

AC-4: The continuity route copies only allowlisted/clamped diagnostics into the `orb.session.continuity.persisted` event payload, never into the stored continuity row; a body from an older widget adds nothing. The widget's reason list equals the route's.
TEST: services/gateway/test/orb/vtid-05001-orb-hide-reasons.test.ts

AC-5: Existing widget behaviour is unchanged — every source-scan suite that pinned `_hide()` now pins the reasoned call at the same place.
TEST: services/gateway/test/frontend (all suites)

AC-6: The widget cache-bust is bumped and every staging check that fetches the widget uses the new versioned URL.
TEST: services/gateway/test/vtid-04659-staging-checks-use-versioned-urls.test.ts

AC-7: Staging serves the new widget (read-only).
CURL: GET https://preview-aws-gateway.vitanaland.com/command-hub/orb-widget.js?v=20261008-vtid-05001-hide-reasons -> 200, contains `transport: 'sse'` and `hide_reason: diag ? diag.hide_reason : undefined`

Data collection after PUBLISH (read-only SQL, not a gate): distribution of `hide_reason` on `orb.session.continuity.persisted` where `ms_since_tap < 5000` and `start_phase = 'connecting'`. The fix for the close itself is a separate, sparred plan.
