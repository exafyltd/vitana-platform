# VTID-03824 — ORB voice: end_conversation tool so the assistant stops instead of reopening the mic

## Report

User says "okay du kannst jetzt ausschalten" ("okay, you can turn off now")
to Vitana in an ORB voice session (Command Hub `/admin/device-preview`).
Vitana speaks a farewell acknowledging it, but the overlay then flips into
LISTENING mode (mic re-armed, ready beep played) instead of closing. Root
cause: no tool existed for the model to signal "the user wants to end this
conversation" outside the two narrowly-scoped Teacher Mode / My Journey
guided-topic end tools, so `turn_complete`'s default path in
`orb-widget.js` unconditionally re-armed the mic once the farewell audio
finished draining.

## Acceptance Criteria

AC-1 — A new `end_conversation` tool is declared for authenticated ORB
sessions, mirroring the existing `end_teaching_session` /
`end_guided_topic_teaching` shape, with an English-intent description (no
hardcoded spoken sentence, per NEVER-rule 41).

TEST: `outputs/jest-widget-suite.txt` — the tool-catalog characterization
snapshot suite passes with the new declaration included.

AC-2 — The system instruction tells the model, in an English INTENT (not a
finished sentence), to speak its own brief farewell and then call
`end_conversation` when the user expresses they want to stop/end/turn off.

TEST: `outputs/jest-widget-suite.txt` — the system-instruction
characterization snapshot suite passes with the new "ENDING THE
CONVERSATION" block included.

AC-3 — The server dispatches an `orb_directive` (`directive:
'end_conversation'`) over SSE/WS when the tool is called, matching the
sibling tools' dispatch shape.

TEST: `commands.log` — `case 'end_conversation':` in
`services/gateway/src/routes/orb-live.ts`, verified by direct read against
the sibling `end_teaching_session`/`end_guided_topic_teaching` cases it
mirrors; `outputs/tsc-noemit.txt` confirms the addition type-checks.

AC-4 — The widget suppresses `turn_complete`'s default listening
transition when `end_conversation` fires, instead of racing a brief
listening flash before closing.

TEST: `outputs/jest-widget-suite.txt` —
`test/frontend/orb-widget-end-conversation.test.ts` asserts
`_s.conversationEnding = true` is set BEFORE the audio-drain wait, and
that `_isClosingForNav()` (the shared guard `turn_complete` already
checks) now also returns true for it.

AC-5 — The widget waits for the farewell audio to actually finish playing
before hiding the overlay — not a fixed short delay that could clip a
longer farewell.

TEST: `outputs/jest-widget-suite.txt` — the same suite asserts the handler
polls `stillPlaying` (audioPlaying / scheduledSources / audioQueue) rather
than hiding on a bare `setTimeout`.

AC-6 — The new `conversationEnding` flag cannot leak across sessions (the
same bug class VTID-03763's stale-poll guard and the
navigationPending/signupClosing reset sites already exist to prevent in
this file).

TEST: `outputs/jest-widget-suite.txt` — asserts the flag is reset to
`false` both inside `_hide()` and alongside
`navigationPending`/`signupClosing` at session start.

AC-7 — An optional `onConversationEnd` host callback is wired end-to-end:
read defensively (guarded on `typeof === 'function'`) at the fire site,
AND assignable from `init(opts)` — VTID-03799 in this same file's own
history shows a callback that is only read and never wired is silently
dead at runtime.

TEST: `outputs/jest-widget-suite.txt` —
`test/frontend/orb-widget-host-callbacks.test.ts` (the existing read-vs-
assigned diff guard) passes with the new callback covered on both sides.

AC-8 — No regression: `tsc --noEmit` is clean and the full gateway test
suite passes.

TEST: `outputs/tsc-noemit.txt` (clean, exit 0) and
`outputs/jest-full-suite.txt` (738/739 suites, 1 pre-existing skip,
13,683/13,718 tests passing, 0 failures).

AC-9 — The VTID is properly self-allocated and registered in the ledger
(not a placeholder tag), per this platform's standing VTID governance.

TEST: `outputs/vtid-allocate.txt` — the `POST /api/v1/vtid/allocate`
response minting VTID-03824, followed by the ledger UPDATE setting
`title`/`status='in_progress'`/`spec_status='approved'`.

## Deliberately NOT attempted

- **Verifying against a live Nova Sonic voice call.** This session has no
  way to place a real ORB voice session, so the fix is verified
  structurally (the tool is declared, dispatched, and handled correctly,
  with the exact same widget-teardown pattern the two working sibling
  tools already use in production) but not yet observed end-to-end
  against a real "turn off" utterance. Flagged explicitly in the PR rather
  than implied as already confirmed live.
- **Extending `end_conversation` to the anonymous/landing-page tool set.**
  The reported bug is on an authenticated session; anonymous sessions get
  no tools at all today (per the existing `buildLiveApiTools` mode gate),
  matching the two sibling end-tools' own scope.
- **A dist/ mirror for `orb-widget.js`.** This PR is declared under the
  `gateway_backend` VALIDATION_PROFILE (it touches `services/gateway/src/routes/`,
  `services/gateway/src/orb/`, and `services/gateway/src/services/` in
  addition to the command-hub frontend file), which does not require the
  src/dist mirroring the narrower `command_hub_frontend` profile's Build
  Gate enforces.
