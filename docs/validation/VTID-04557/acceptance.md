# VTID-04557 / VTID-04558 — Voice navigation fixes found by the end-to-end test pass

Two defects the 2026-09-25 end-to-end test pass of the registry navigator
(VTID-04517/04520/04521) found, fixed and re-verified.

**VTID-04557 — open/show requests go to navigate, and Vitana never claims a
screen opened without a navigation call.** Real Nova Sonic, spoken input
(Polly PCM), the production prompt at 30.8 KB and the live production
registry: "Open my messages." called `view_messages`, never navigated, and
Vitana said "Let me take you to your messages screen now." Two rules were
added to `NAVIGATOR_POLICY_V2`: open/show/take-me-to wins over content tools,
and no navigation call means no claim that something opens. Re-run of the
same 14 spoken scenarios: "Open my messages." now opens `INBOX.OVERVIEW`;
the other 13 are unchanged.

**VTID-04558 — closing Vitana cancels a navigation she announced but has not
run yet.** Headless Chromium, the real app and the real widget against a fake
gateway: when the member closed the orb while a speak-first navigation was
pending, the app still moved to the new screen 14.7 s later (the 15 s safety
timer), and the gateway was never told. `_hide()` and `_sessionStop()` now
call `_cancelPendingNav()`, which clears the held directive and its timer and
bumps a counter that `_runNavDirective` checks before navigating. Browser
re-run: closing before `turn_complete` and closing during the audio drain
after it both stay on `/home` for 21 s; every other scenario is unchanged.

## Acceptance criteria

AC-1 The V2 navigator policy tells the model that open/show requests go to navigate rather than to content tools, and forbids claiming a screen opens without a navigation result.
TEST: services/gateway/test/navigation/nav-dispatch.test.ts

AC-2 Closing or stopping the orb cancels a held navigation: the directive and its safety timer are cleared, and the drain wait and the final hop both re-check the cancel counter.
TEST: services/gateway/test/frontend/orb-widget-speak-then-navigate.test.ts

AC-3 The navigation flow suites (resolver, dispatcher, ack, turn scope, golden set) still pass.
TEST: services/gateway/test/navigation/nav-resolver.test.ts
