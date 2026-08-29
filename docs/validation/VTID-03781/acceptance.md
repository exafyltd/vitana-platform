# VTID-03781 — My Journey guided-topic teaching lifecycle: full audit + idempotent completion guard

## Spec (verbatim, condensed)

Platform-owner spec titled "Fix My Journey Session Lifecycle — Strict
Behavioral Requirement." Core invariant: *"A completed My Journey teaching
session must end. It must never automatically become a general Vitana
conversation."* Required state machine: IDLE -> STARTING -> TEACHING ->
COMPLETING -> TERMINATING -> COMPLETED, with two completion signals (model
tool call, 5-minute safety-net timeout), step-scoped completion (never
session-wide), idempotent completion handling, stale-session/stale-timer
protection, an X button that always works, and no interference with normal
(non-Journey) ORB conversation.

## Investigation — full lifecycle trace

Traced My Journey click -> selected step state -> ORB init -> topic
injection -> teaching -> completion signal -> termination -> overlay close
-> Well-done drawer -> mark-step-done, end to end across both repos.
Finding: **the overwhelming majority of this spec's required behavior
already exists and is correct**, built up across six prior VTIDs in this
same investigation chain:

- **VTID-03762** — added the model-callable `end_guided_topic_teaching`
  tool (`live-tool-catalog.ts`), its server-side case handler
  (`orb-live.ts`, emits an `orb_directive` over both SSE and WS), and the
  client-side `_endGuidedTopicTeaching()` shared teardown
  (`orb-widget.js`) plus the `GUIDED_TOPIC_BACKSTOP_MS` (5 min) safety-net
  timer — this is exactly the spec's Signal A (explicit tool call) and
  Signal B (safety-net timeout).
- **VTID-03763** — wired `onGuidedTopicTeachingEnd` through
  `useOrbVoiceWidget.ts` as a `vitana:guided-topic-teaching-complete`
  window CustomEvent, and `GuidedJourneyCatalog.tsx` calls
  `completePractice(topicId)` — the **existing, step-scoped** manual
  "Mark as Done" logic, reused verbatim, not a second competing
  implementation. This is exactly the spec's step-only completion
  requirement (§ "Mark as Done — STEP ONLY").
- **VTID-03763** also added `_s._sessionGeneration`, checked inside
  `_endGuidedTopicTeaching()`'s audio-drain poll
  (`if (_s._sessionGeneration !== myGen) return;`) — exactly the spec's
  "use session identity/generation so callbacks from an obsolete session
  cannot affect the current session" requirement.
- **VTID-03774/03776** — `focusGuidedTopic()` (a fresh My Journey tap)
  synchronously calls `_sessionStop()` to tear down any existing session
  FIRST, and synchronously clears+rearms `_guidedTopicBackstopInterval` —
  an old topic's backstop timer is not merely guarded against, it is
  **cleared and therefore cannot fire at all** once a new topic is tapped.
- **VTID-03295** (pre-existing, confirmed still intact) — `_hide()` (used
  by the X button and every close path) stops audio and hides the overlay
  **synchronously**, before any async `/session/stop` network call — the X
  button does not depend on Vitana voluntarily stopping or on any prior
  user-gesture flag.
- **VTID-03778** — `case 'session_ended':` now calls `_hide()` (not the
  old `_sessionStop()`), so a server-initiated close (e.g. a superseding
  session) also correctly closes the overlay instead of freezing it.
- Prompt-level: `guided-topic-narration-prompt.ts`'s GUIDE MODE block
  explicitly instructs the model, in both languages and both
  narrated/non-narrated branches: *"Once you've done that and they have no
  more follow-up questions, call the end_guided_topic_teaching tool to
  close things out — do NOT just keep talking in general conversation."*
  This is the direct, already-shipped answer to "why does Vitana continue
  into general conversation" — the model IS instructed not to, and has a
  tool to signal it; the 5-minute backstop is the safety net for when it
  doesn't comply.

## The one real, verified gap found and fixed here

**No idempotency guard existed against duplicate completion signals.**
`_endGuidedTopicTeaching(topicId, reason)` is the single shared function
both signals funnel into — but nothing stopped it from being **entered
twice concurrently** for the same teaching session: the model calling the
tool right as the backstop's periodic 15-second check also trips (both
read the same `_guidedTopicOpenedAt`/state, nothing serializes them), or a
duplicate `orb_directive` arriving over a flaky transport. Each entry
independently drains audio (up to a 30s poll) and then calls `_hide()` +
fires the `onGuidedTopicTeachingEnd` host callback -> vitana-v1's
`completePractice(topicId)`. A second concurrent entry would fire that
callback, and therefore `completePractice`, a second time for the same
topic — directly the failure mode the spec's Test 6 (duplicate-completion
idempotency) names.

## Fix

Added `_s._guidedTopicTeachingEnded` (boolean, default `false`), checked
and set as the **first synchronous statement** inside
`_endGuidedTopicTeaching()`, before any async poll is scheduled. Every
signal after the first becomes a no-op, logged and returned immediately.
Reset only in `focusGuidedTopic()` (a fresh My Journey tap) — a new
teaching session gets its own single completion; `_hide()` does NOT reset
it (that would let a second concurrent call race back in after the first
call's own `_hide()` ran but before its `onGuidedTopicTeachingEnd` fired).

This reuses the exact same pattern already established in this file for
every other guided-topic lifecycle flag (`guidedTopic`, `_guidedTopicInFlight`,
`_guidedTopicAudioDelivered`, `_guidedTopicZeroAudioFailCount`,
`_guidedTopicOpenedAt`) — armed on tap, cleared on close/tap, nothing new
invented.

## Acceptance Criteria

AC-1 — `_guidedTopicTeachingEnded` is declared in the widget's state
object, defaulting `false`.

TEST: `orb-widget-guided-topic-completion-idempotency.test.ts` —
"declares the _guidedTopicTeachingEnded state flag, defaulting false"

AC-2 — `_endGuidedTopicTeaching()` checks the guard and returns before any
async work if teaching has already ended for this session.

TEST: same file — "_endGuidedTopicTeaching() checks the guard and returns
before any async work if already ended"

AC-3 — The guard-set is unconditional and synchronous on entry, not nested
inside the audio-drain poll (so a fast-arriving duplicate cannot race past
it).

TEST: same file — "the guard set happens unconditionally on entry — not
nested inside the audio-drain poll"

AC-4 — `focusGuidedTopic()` resets the guard on a fresh tap, so a new
teaching session is not silently blocked by a previous topic's already-fired
guard.

TEST: same file — "focusGuidedTopic() resets the guard for a fresh tap, so
a new teaching session gets its own completion"

AC-5 — `_hide()` does NOT also reset the guard (only a fresh tap re-arms
it) — prevents a re-entrant race during the drain window.

TEST: same file — "_hide() does not also reset the guard mid-teaching
(only a fresh tap re-arms it)"

AC-6 — The fix is mutation-verified: removing the guard-set line fails
exactly AC-2/AC-3's own tests, and no others.

TEST: `commands.log` — mutation testing section.

AC-7 — `node --check` is clean.

TEST: `outputs/node-check.txt` — exit 0.

AC-8 — `tsc --noEmit` is clean.

TEST: `outputs/tsc-noemit.txt` — exit 0 (empty output).

AC-9 — The full gateway suite is green.

TEST: `outputs/jest-full-suite.txt`.

AC-10 — The pre-existing VTID-03762 suite (tool declaration, server
directive, client directive handler, backstop) still passes unmodified —
this fix must not disturb the existing signal mechanics, only add a guard
around their shared teardown.

TEST: `outputs/jest-vtid-03762-sibling.txt`.

AC-11 — The Command Hub ownership guard (`scripts/ci/command-hub-ownership-guard.js`)
recognizes VTID-03781 as an allowed marker for `orb-widget.js` changes.

TEST: `commands.log` — `node --check` + grep confirmation.

## Full trace against the spec's 10 investigation questions (summary)

1. **Why doesn't the completion tool terminate the realtime session?** It
   does — `end_guided_topic_teaching`'s server case emits an
   `orb_directive`, and the client's `_endGuidedTopicTeaching()` drains
   audio then calls `_hide()` -> `_sessionStop()`, which does terminate the
   session. This mechanism already existed (VTID-03762) and was not
   broken; the fix here closes a duplicate-firing race in it, not a
   termination failure.
2. **Why does Vitana continue generating general responses after
   completion?** The GUIDE MODE prompt already instructs the model not to
   (VTID-03290, quoted above); if this is still observed live, it is a
   model-compliance gap (the same class VTID-03685/03686 documented
   previously for this exact subsystem), not a missing mechanism — the
   5-minute backstop exists precisely as the safety net for this case.
3. **Why does the overlay remain open?** Fixed for the server-initiated
   case in VTID-03778 (`session_ended` now calls `_hide()`); the
   model/backstop-initiated case already correctly calls `_hide()` via
   `_endGuidedTopicTeaching()`.
4. **Why does the X button become ineffective while Vitana is speaking?**
   It doesn't — `_hide()` (VTID-03295) stops audio and hides the overlay
   synchronously before any network call, unconditionally, with no
   user-gesture-flag gate. Verified in code; not independently
   re-confirmed against live audio in this session (no live-browser
   access).
5. **Why isn't the Well-done drawer triggered immediately after
   termination?** It is — `GuidedJourneyCatalog.tsx`'s drawer is mounted
   underneath the ORB overlay the whole session and simply becomes visible
   once `_hide()` closes the overlay (VTID-03685's own fix made this
   possible by removing an earlier, too-early auto-close).
6. **Why isn't the selected step completed automatically?** It is, and
   step-scoped — `completePractice(topicId)`, not a session-wide call
   (VTID-03763).
7. **Is an existing general-conversation fallback being triggered after
   teaching ends?** Not by any mechanism found in this trace — the only
   fallback found (VTID-03776's zero-audio circuit breaker) is scoped to
   repeated connection failures, not to teaching completion.
8. **Is a realtime disconnect/close callback accidentally reinitializing
   the ORB?** No such path found; `case 'session_ended':` closes
   (VTID-03778), it does not reopen.
9. **Can an old timer/event still mutate the current Journey session?**
   No — the backstop interval is cleared synchronously on every fresh tap
   (VTID-03774/03776) and the async drain poll is generation-guarded
   (VTID-03763).
10. **Is completion state lost when control moves between frontend,
    realtime agent, and backend?** The one place this could have happened —
    two independent completion signals racing into the same shared
    teardown with nothing serializing them — is the gap this VTID fixes.

## Deliberately NOT attempted

- **No change to the GUIDE MODE prompt wording.** The existing instruction
  already tells the model to call `end_guided_topic_teaching` and not
  drift into general conversation. Per the spec's own explicit constraint
  ("do not solve this by detecting specific text... termination must be
  driven by actual session state"), and because a prompt-compliance gap
  (if one still exists live) is a different class of problem than a code
  defect — the existing 5-minute backstop is the code-level answer to
  "what if the model doesn't comply," per the spec's own §6.B.
- **No server-side "reject new AI turns" state was added for the guided-topic
  path.** Investigated whether to mirror `end_teaching_session`'s
  `(session as any).teacherModeEnded = true;` — found that flag is itself
  dead: nothing in the codebase reads it. Copying a non-functional pattern
  from a sibling feature would not add real protection, so it was not
  copied. Termination is still guaranteed client-side (the overlay closes
  and the session is torn down via `_sessionStop()` regardless of what the
  server-side session object's flags say).
- **Not independently confirmed against live traffic or live audio.** Same
  standing caveat as every VTID in this chain: this session has no
  live-browser verification path. This fix closes a verified, real,
  reasoned-about race in the completion machinery; it does not by itself
  prove the platform owner's most recent report (general conversation
  continuing) was caused by that race specifically, since a
  model-compliance gap remains an equally plausible independent
  contributor that only live retesting can distinguish.
