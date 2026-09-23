# VTID-04355 — Conversation rebuild WS-0.5: the acceptance gate consumes only the offers it runs

Plan v1 (Conversation Intelligence Rebuild), Phase 0, workstream WS-0.5.
Ships in PR #3614 as a companion to VTID-04339 (VTID-04246 precedent for
companion VTIDs in one PR).

## What was wrong (read from the code on the pre-change tree)

- **The gate consumed offers it would not run.** On a bare "ja"/"yes",
  `maybeBindAcceptance()` (`assistant-continuation/acceptance-gate.ts`) read
  `pending_cta`, **cleared it**, and returned it.
- Both turn-loop call sites (`upstream-message-handler.ts`, ~L669 and ~L2343)
  then dispatch **only** `navigate_to_screen`, and only when the payload has
  both `screen_id` and `route`. Anything else was dropped without a trace.
- **Offers that were consumed and then dropped:**
  - Any non-navigation offer: a tool recorded via `offer_action` (which accepts
    any `ORB_TOOL_REGISTRY` tool), or the wake-brief `onYesTool`
    (`activate_recommendation`).
  - A `navigate_to_screen` offer with only `screen_id` (the shape the old test
    fixture itself used).
- **It also broke a fallback.** `activate_recommendation` reads `pending_cta` as
  its fallback when the model calls it without an id. The gate had already
  cleared the offer by the time that call arrived, so an accepted
  recommendation lost its target.
- **`offer_action` gave the wrong guidance.** It told the model every offer
  "runs automatically", so for a non-navigation offer the model waited for an
  automatic run that never came.

## Fix

- `isAutoRunnableOffer(cta)`: true only for `navigate_to_screen` with non-blank
  string `screen_id` and `route`. That is exactly what the call sites dispatch.
- `maybeBindAcceptance()` returns null and **leaves `pending_cta` in place**
  when the stored offer is not auto-runnable. It clears the offer only when it
  will run it, so the one-shot guarantee for navigation is unchanged.
- `offer_action` now returns `result.auto_runs`, and its guidance text depends
  on it:
  - **Auto-runnable:** the navigation runs on acceptance (unchanged wording).
  - **Otherwise:** nothing runs automatically. On acceptance, call `<tool>`
    yourself with exactly the stored payload; on a decline, drop it.
- **Deliberately not done:** server-side execution of arbitrary offered tools
  on a bare "yes". That would widen autonomy (some registry tools move money or
  post socially) and needs its own decision. This fix only makes the gate stop
  swallowing offers.

## Acceptance criteria

AC-1: A well-formed `navigate_to_screen` offer (screen_id + route) is still returned and consumed exactly once on acceptance.
TEST: services/gateway/test/acceptance-gate.test.ts ("acceptance + live pending_cta → returns the exact stored action and consumes it")

AC-2: A non-navigation offer (e.g. `activate_recommendation`) is NOT consumed on acceptance and the gate returns null.
TEST: services/gateway/test/acceptance-gate.test.ts ("acceptance + a non-navigation tool → null and the offer is left in place")

AC-3: A `navigate_to_screen` offer missing `route` or `screen_id` (or with blank values) is NOT consumed.
TEST: services/gateway/test/acceptance-gate.test.ts ("navigate_to_screen without route / without screen_id / with blank fields")

AC-4: `isAutoRunnableOffer` matches exactly the shape the two call sites dispatch.
TEST: services/gateway/test/acceptance-gate.test.ts ("isAutoRunnableOffer (VTID-04355)")

AC-5: `offer_action` reports `auto_runs` and tells the model to call the tool itself, with the stored payload, when the offer will not auto-run.
TEST: services/gateway/test/offer-action.test.ts ("offer_action guidance matches what the gate runs (VTID-04355)")

AC-6: No regression in the NAV_CONTINUATION_BIND flag pin, the session-state store, the recommendation provider, `activate_recommendation`, or the ORB suite.
TEST: services/gateway/test/vtid-04258-nav-continuation-bind-flag-pinned.test.ts, services/gateway/test/voice-activate-recommendation-shared.test.ts, services/gateway/test/orb

## Not verified live

- No accepted offer has been observed on staging after this change.
- The live signal to watch after merge:
  - An accepted navigation offer still logs `[NAV-CONTINUATION-BIND] accepted pending offer`.
  - An accepted `activate_recommendation` offer still finds its `pending_cta`
    when the model's own tool call arrives.
