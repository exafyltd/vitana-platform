# VTID-04355 — Conversation rebuild WS-0.5: every offered action gets one outcome, and "yes" works for every offer

Plan v1 (Conversation Intelligence Rebuild), Phase 0, workstream WS-0.5.
Ships in PR #3614 as a companion to VTID-04339 (the VTID-04246 precedent for
companion VTIDs in one PR).

## What was wrong (read from the code on the pre-change tree)

- **The gate consumed offers it would not run.** On a bare "ja"/"yes",
  `maybeBindAcceptance()` (`assistant-continuation/acceptance-gate.ts`) read
  `pending_cta`, **cleared it**, and returned it.
- **Both turn-loop call sites run only navigation.** `upstream-message-handler.ts`
  (~L669 and ~L2343) dispatch only a `navigate_to_screen` that has both
  `screen_id` and `route`. Everything else was dropped without a trace:
  - an offer recorded via `offer_action`, which accepts any `ORB_TOOL_REGISTRY` tool;
  - the wake brief's `onYesTool` (`activate_recommendation`);
  - a navigation offer with only `screen_id`.
- **That also broke a fallback.** `activate_recommendation` reads `pending_cta`
  when the model calls it without an id, but the gate had already cleared the
  offer, so an accepted recommendation lost its target.
- **`offer_action` told the model every offer "runs automatically"**, so for a
  non-navigation offer the model waited for something that never happened.
- **No offer had an outcome.** Four places wrote `pending_cta` directly
  (`offer_action`, two navigator branches, the wake brief), so nothing recorded:
  - that an offer was made;
  - a replaced offer, which vanished;
  - a "no", which left the offer live for its whole TTL, where a later
    unrelated "ja" could still fire it.

## Fix

- **`offer-outcomes.ts` is the single writer.**
  - `recordPendingOffer()` stores the offer with `offer_id`, `source`, `provider`
    and `key`, and emits `conversation.offer.made`.
  - A still-open offer it replaces gets `conversation.offer.ignored`
    (`reason: replaced`).
  - All four writers use it.
- **The gate:**
  - **"ja":** `conversation.offer.accepted`, exactly once. A second "ja" on an
    already-accepted offer does nothing.
  - **Well-formed navigation** (`isAutoRunnableOffer`): cleared and dispatched
    as before.
  - **Any other offer:** left in place, marked `accepted_at`, and recorded as
    awaiting the model's own tool call.
  - **"no"** (`detectDecline`, short refusal words, umlaut-safe):
    `conversation.offer.declined`, and the offer is cleared.
- **Cleared only after success.** `dispatchOrbTool` clears an accepted offer
  once its tool returns ok (`settleOfferOnToolSuccess`, in-process check first,
  so other tool calls cost nothing). A failed call keeps the offer for a retry.
  `activate_recommendation` already did the same for itself.
- **`offer_action` reports `auto_runs`** and tells the model to call the tool
  itself, with the stored payload, when the offer will not run on its own.
- **Unanswered offers that expire** produce no event of their own. The metrics
  rollup (WS-0.7) counts them as ignored: made minus accepted, declined and
  ignored.

## A deliberate difference from the Plan v1 wording

Plan v1 says the gate "carries out any tool on an allowlist". It does not.
Server-side execution of an arbitrary registry tool on a bare "yes" would
widen what runs without the model in the loop, and some registry tools move
money or post socially. That needs its own decision.

The same outcome is reached a safer way: the offer survives acceptance, the
model is told to run it, and the offer is cleared on success. The plan's other
two requirements are met as written:
- the offer is deleted only after the action succeeds;
- every offer ends in one outcome event.

## Acceptance criteria

AC-1: A well-formed `navigate_to_screen` offer is returned and consumed exactly once on "yes", with an accepted event (auto_runs true).
TEST: services/gateway/test/acceptance-gate.test.ts, services/gateway/test/services/assistant-continuation/vtid-04355-offer-outcomes.test.ts

AC-2: A non-navigation offer is not consumed on "yes"; it is marked accepted for the model and an accepted event (auto_runs false) is emitted once; a second "yes" does nothing.
TEST: services/gateway/test/services/assistant-continuation/vtid-04355-offer-outcomes.test.ts

AC-3: A navigation offer missing route or screen_id is not consumed.
TEST: services/gateway/test/acceptance-gate.test.ts

AC-4: A short refusal clears the offer and emits a declined event; a redirect or a long sentence is not a decline.
TEST: services/gateway/test/services/assistant-continuation/vtid-04355-offer-outcomes.test.ts

AC-5: Recording an offer emits made; a replaced unanswered offer emits ignored; a failed write emits nothing; an emit failure never fails the write.
TEST: services/gateway/test/services/assistant-continuation/vtid-04355-offer-outcomes.test.ts

AC-6: An accepted offer the model runs is cleared only when that tool succeeds.
TEST: services/gateway/test/services/assistant-continuation/vtid-04355-offer-outcomes.test.ts

AC-7: `offer_action` reports `auto_runs` and gives guidance that matches what the gate runs.
TEST: services/gateway/test/offer-action.test.ts

AC-8: No regression in the flag pin, the recommendation activation, the navigator, the session-state store or the ORB suite.
TEST: services/gateway/test/vtid-04258-nav-continuation-bind-flag-pinned.test.ts, services/gateway/test/voice-activate-recommendation-shared.test.ts, services/gateway/test/nav-guided-journey.test.ts, services/gateway/test/orb

## Not verified live

- No offer has been accepted or declined on staging after this change.
- The signals to watch after merge:
  - `conversation.offer.made` and `conversation.offer.accepted` events carrying
    the same `offer_id`.
  - An accepted navigation still logs `[NAV-CONTINUATION-BIND] accepted pending offer`.
