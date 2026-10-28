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

## Follow-up (2026-09-12) — live staging test found the mechanism worked but the model still didn't comply

The platform owner ran a real manual test on staging after the fix above
deployed and reported it did not work, with a screenshot of a German
conversation where Vitana kept responding instead of ending the session.
Investigated via a direct, read-only query against `oasis_events` (topic
per §6 of this repo's CLAUDE.md — no writes made to any production table
for this investigation) for the reported session window.

**Finding: the `end_conversation` tool mechanism itself worked exactly as
built.** One session (`live-1a258a4e-...`) called `end_conversation` and
closed cleanly (~4s from call to session teardown) — AC-1 through AC-7
above are confirmed against a real invocation, not just structurally. The
actual defect was upstream of the tool: on an earlier turn in the same
reported conversation, the model did NOT call the tool on a repeated stop
request and instead replied with a proactive follow-up question
("Was möchtest du als Nächstes angehen?" — "What would you like to tackle
next?") — a near-verbatim match of the system instruction's own RULE 0
banned-phrase list. A direct read of `orb.live.diag` (`stage:
nova_instruction_debug_dump`) for that session's own rendered system
instruction confirmed why: the original "ENDING THE CONVERSATION"
paragraph (AC-2 above) was positioned BEFORE "PROACTIVE LEADERSHIP — RULE 0
(ABSOLUTE, EVERY TURN, NO EXCEPTIONS, ALL TENURES)" with materially less
emphasis (no all-caps header, no explicit override framing) — RULE 0's
much louder, later, "NO EXCEPTIONS" framing plausibly won the conflict on
a repeated stop request.

AC-10 — The "ENDING THE CONVERSATION" instruction is positioned and framed
so it wins against RULE 0 instead of merely coexisting with it: moved to
AFTER the RULE 0 section (recency) and reframed as an explicit, named
exception ("OVERRIDES RULE 0 (ABSOLUTE)" / "SUSPENDED"), with an added
explicit instruction covering the reported failure mode (the user having
to repeat the stop request). The block is kept under ~1100 chars to stay
well inside the ~32-33KB session-instruction budget this repo has
previously measured triggering real Nova content-filter blocks
(VTID-03795/03787).

TEST: `outputs/jest-rule0-precedence-followup.txt` — new
`test/orb/live/instruction/end-conversation-rule0-precedence.test.ts` (7
tests) pins the block's position (after, not before, RULE 0), its override
framing, its handling of a repeated stop request, that it still carries a
farewell + carve-out for Teacher Mode/My Journey, and its length budget;
the system-instruction characterization snapshot suite is re-recorded and
passing alongside it. `outputs/tsc-noemit-followup.txt` (clean, exit 0)
and `outputs/jest-orb-frontend-followup.txt` (230/230 suites, 3807/3813
tests passing, 6 pre-existing todo, 0 failures) confirm no regression.

**Deliberately NOT claimed:** this fix is verified structurally (the
instruction now wins the position/emphasis/recency contest against RULE 0
in every rendered persona this repo's test fixtures cover) — it is not yet
independently re-confirmed against a real live Nova conversation, for the
same reason as the original fix: this session cannot place a real ORB
voice call. The next real signal is another live staging test.

## Second follow-up (2026-09-12) — the repositioned instruction still lost to Nova's own judgment; added a deterministic backstop

The platform owner retested on staging immediately after the first
follow-up (RULE 0 repositioning) deployed, and reported it still "doesn't
work" with a second screenshot: Vitana acknowledged the user's repeated
stop requests in words ("Alles klar, ich gehe jetzt. Ich bin jetzt weg.")
but never actually ended the session.

Investigated via a direct, read-only `oasis_events` query against the
exact reported session (`live-2dafffa5-fe05-4ad7-8294-53803185549d`,
12:52-12:53 UTC). Two things were checked and BOTH ruled out before
concluding this is a genuine model-compliance gap:

1. **Was the fix even deployed/rendered?** Confirmed yes — the session's
   own `nova_instruction_debug_dump` shows "ENDING THE CONVERSATION" at
   character offset 9687 of a 32,406-character instruction, AFTER
   "PROACTIVE LEADERSHIP" (offset 2954) and immediately followed by
   "OVERRIDES RULE 0" (offset 9713) — byte-for-byte the exact text this
   VTID's first follow-up shipped. Not a stale-deploy or wrong-host issue.
2. **Did the tool ever get called?** Confirmed no. The full turn-by-turn
   trace for this session (6 turns) shows zero `end_conversation` tool
   calls anywhere, despite five separate turns transcribing an explicit
   stop/leave-me-alone request, including "du bist immer noch da" ("you're
   still here") verbatim twice. The session only ended because the CLIENT
   sent `upstream_closed reason:"user_stop"` — i.e. the user closed the
   widget themselves; Vitana never did.

This is a real Nova tool-calling compliance gap, not a prompt-precedence
or deployment bug — the exact instruction text this VTID already fixed to
"win" against RULE 0 in principle still didn't make the model act on it
in this real conversation.

**Fix:** rather than a third round of prompt wording, added a
deterministic, code-level backstop — matching this repo's own established
remedy for this failure shape (VTID-03650: "stop asking a conversational
model to read curriculum text at all" once prompt compliance proved
unreliable). `handleTurnComplete` (`upstream-message-handler.ts`) now
inspects each completed turn's transcribed user text via a new
`detectStillHereComplaint()` (`orb-live.ts`) — a small, high-precision
EN/DE regex set matching ONLY the unambiguous "you're still here" / "du
bist (immer) noch da" complaint (deliberately NOT a broad stop-intent
classifier — that would risk false-positives on legitimate pause requests
like "let's talk later"; "you're still here" is never said except in
direct response to an assistant that already failed to leave). On a
match, the server dispatches the exact same `orb_directive:
end_conversation` message the TOOL sends
(`dispatchEndConversationDirective()`, extracted from the tool handler so
both paths are byte-identical) — reusing the widget's already-built,
already-tested close handling with ZERO client-side changes. Idempotent
per session (`session.stillHereEndDispatched`) so a stray extra matching
turn can't double-dispatch. Wired into all three
`bindUpstreamSessionHandlers` call sites (cascaded, Nova, Vertex-legacy)
so both WS and SSE transports (which share this path since VTID-03471)
get the backstop.

AC-11 — A deterministic, code-level backstop force-ends the session when
the user's transcribed turn is an unambiguous "you're still here"
complaint, independent of whether the model calls the tool.

TEST: `outputs/detect-still-here-complaint.txt` —
`test/orb/live/detect-still-here-complaint.test.ts` (20 tests) pins the
regex against the exact reported live phrasings (EN+DE) and confirms it
stays silent on ambiguous phrases ("let's talk later", a first-time
explicit stop request) that must NOT force-end a session.
`outputs/still-here-complaint-backstop.txt` —
`test/orb/live/session/still-here-complaint-backstop.test.ts` (5 tests)
proves the real (unmocked) `detectStillHereComplaint`/
`dispatchEndConversationDirective` wiring fires end-to-end through
`handleTurnComplete`, including idempotency and the greeting-turn/
inactive-session guards, and that the real directive JSON is actually
sent over the (fake) client WebSocket.

TEST: `outputs/tsc-noemit-round3.txt` (clean, exit 0) and
`outputs/jest-full-suite-round3.txt` confirm no regression across the full
gateway suite, including the two pre-existing test files
(`upstream-provider-parity.test.ts`, `upstream-session-binding.test.ts`)
whose own `makeDeps()` needed the two new required dependency fields
added.

**Deliberately NOT claimed:** this backstop only covers the specific,
reproduced "you're still here" repeat-complaint — the narrowest, highest-
precision signal available. It does not attempt to force-end on a FIRST
stop request (still relies on the prompt-level instruction there,
deliberately, to avoid false-positives on ambiguous first utterances like
"let's talk later"). Also not independently re-confirmed against a fresh
live Nova conversation for the same reason as every round in this
VTID — this session cannot place a real ORB voice call. The next real
signal is another manual staging test.

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
