# VTID-03746 — unconditional disconnect alert + lost guided topic on mid-lesson disconnect

Live-reproduced on staging by the platform owner via a real guided-topic tap
(topic T007, `oasis_events` trace 2026-08-26 08:45–08:46 UTC), reported
verbatim: "first thing i hear is: einen moment die verbindung wird wieder
hergestellt. then vitana starts talking and its a new day greeting instead
of reading the session." The session correctly won the guided-topic
candidate and taught it for 44 real seconds (497 audio chunks) before
disconnecting mid-lesson — VTID-03727's earlier fixes are confirmed working.
Two distinct, previously-unfixed defects in
`services/gateway/src/frontend/command-hub/orb-widget.js`.

## Root cause

1. `_announceDisconnect(reason)` called `_playAlert('disconnect-' + reason +
   '-' + clipLang)` unconditionally on every disconnect. VTID-03727 already
   gated the equivalent *visual* status caption on `_s._audioEverHeardThisOpen`
   in `_attemptReconnect()`; the *audible* alert clip never got the same
   treatment, so an early `nova_validation`-style close still spoke the
   reconnect line before Vitana had said a word.
2. The `turn_complete` handler nulls `_s.guidedTopic` as soon as the first
   turn completes (VTID-03675's "delivered, don't re-offer" rule), which
   assumed turn-1-complete meant fully taught. Once VTID-03650/VTID-03665
   moved the actual teaching into a longer multi-turn GUIDE-MODE
   conversation, a disconnect mid-lesson (after turn 1) left
   `_attemptReconnect()`'s retry with nothing to resume, so it fell through
   to a generic greeting instead of continuing the same topic.

## Fix

1. `_announceDisconnect()` now gates the `_playAlert(...)` call on
   `_s._audioEverHeardThisOpen` — nothing heard yet this open suppresses the
   spoken clip (still logs to console); real audio already played still
   gets the spoken cue, unchanged.
2. New `_s._guidedTopicInFlight` field: set alongside `_s.guidedTopic` in
   `focusGuidedTopic()`, deliberately NOT cleared by the `turn_complete`
   handler that nulls `guidedTopic` itself, so it survives past "delivered".
   `_attemptReconnect()`'s retry re-arms `_s.guidedTopic` from it
   (`if (_s._guidedTopicInFlight && !_s.guidedTopic) { _s.guidedTopic =
   _s._guidedTopicInFlight; }`) immediately before calling `_sessionStart()`
   — only on this unexpected-disconnect retry path, never on a clean
   `_hide()`/`_sessionStop()`, which clears it instead (same lifecycle as
   `guidedTopic`).

---

AC-1 — `_announceDisconnect()` no longer calls `_playAlert` unconditionally

TEST: `services/gateway/test/frontend/orb-widget-guided-topic-mid-lesson-resume.test.ts`
— "does not call _playAlert unconditionally". Mutation-verified: reverting
the fix alone fails this test.
Output: `outputs/jest-vtid-03746-suite.txt`

AC-2 — the spoken alert clip is gated on `_s._audioEverHeardThisOpen`

TEST: same suite — "gates the spoken alert clip on _audioEverHeardThisOpen".
Output: `outputs/jest-vtid-03746-suite.txt`

AC-3 — the alert still plays once real audio HAS been heard this open (no
regression to the normal mid-conversation-disconnect case)

TEST: same suite — "still plays the alert once real audio has been heard
(no regression to the normal case)".
Output: `outputs/jest-vtid-03746-suite.txt`

AC-4 — `_s._guidedTopicInFlight` is declared in initial state and armed
alongside `_s.guidedTopic` in `focusGuidedTopic()`, in the correct order

TEST: same suite — "is declared in the initial _s state, defaulting to
null" + "focusGuidedTopic arms it alongside _s.guidedTopic".
Output: `outputs/jest-vtid-03746-suite.txt`

AC-5 — `_guidedTopicInFlight` survives the turn-complete point that nulls
`_s.guidedTopic` (the entire point of the fix)

TEST: same suite — "is NOT cleared at the first-turn-complete point that
nulls _s.guidedTopic".
Output: `outputs/jest-vtid-03746-suite.txt`

AC-6 — `_attemptReconnect()`'s retry re-arms `_s.guidedTopic` from
`_guidedTopicInFlight` only when `guidedTopic` was already cleared, and
does so BEFORE calling `_sessionStart()`

TEST: same suite — "_attemptReconnect re-arms _s.guidedTopic from
_guidedTopicInFlight only when guidedTopic was already cleared".
Output: `outputs/jest-vtid-03746-suite.txt`

AC-7 — `_hide()` clears `_guidedTopicInFlight` (a real, user-initiated close
ends the overlay session; nothing should resume after that)

TEST: same suite — "_hide() clears _guidedTopicInFlight — a real close ends
the overlay session".
Output: `outputs/jest-vtid-03746-suite.txt`

AC-8 — real-browser confirmation: after a simulated mid-lesson disconnect,
the reconnect's WebSocket `start` frame actually resends `guided_topic_id`
(not just asserted at the source-code level — exercised end-to-end against
the real widget in a real browser)

TEST: local Playwright harness (`/tmp/.../scratchpad/vtid-03727-e2e/`) —
a mock WS server speaking the exact gateway wire protocol serves the real,
unmodified `orb-widget.js` to real Chromium; Scenario B opens a guided
topic (`T_HARNESS_B`), delivers real audio, forces a mid-lesson close, and
inspects the 3rd WebSocket connection's `start` payload. Check "B9" —
`reconnectStart={"connId":3,...,"guided_topic_id":"T_HARNESS_B",...}` — PASS.
No live ORB session was opened against staging/production, per this repo's
absolute governance rule; this harness is fully local (127.0.0.1, no
external network, no Supabase, no real Nova/Bedrock).
Output: `outputs/e2e-harness-run.log`

AC-9 — the mic button and X-close button remain responsive during a
mid-reconnect window (no regression to VTID-03727's earlier fixes)

TEST: same harness — checks "B7" (mic button responsive while
RECONNECTING) and "B10" (X close button closes overlay even mid-reconnect),
both PASS. Screenshots visually inspected
(`artifacts/B9-mic-click-during-reconnect.png`,
`artifacts/B11-closed-during-reconnect.png`) — muted state renders
correctly, overlay closes to a blank page with no visual glitch.
Output: `outputs/e2e-harness-run.log`

AC-10 — full gateway regression suite is clean (no suite broken by either
fix)

TEST: `npx jest` (full suite, all 711 test suites).
Output: `outputs/jest-full-suite.txt` — 710/711 suites passed (1
pre-existing skip), 13,387/13,422 tests passing, 0 failures.

AC-11 — the edited file typechecks cleanly and remains valid JavaScript

TEST: `npx tsc --noEmit` (clean, no output) and `node --check
services/gateway/src/frontend/command-hub/orb-widget.js` (exit 0).
Output: `outputs/tsc-check.txt`, `outputs/node-check.txt`

AC-12 — the diff introduces no new CSP-relevant pattern in the
CSP-governed surface

TEST: ran the same check `VALIDATOR-CHECK.yml`'s "CSP Governance Gate" step
runs — `git diff origin/main...HEAD -- 'services/gateway/src/frontend/'
'services/gateway/dist/frontend/'` piped into `node
scripts/ci/validator-path-guard.cjs --csp-added-lines <diff>` — locally,
before pushing.
Output: `outputs/csp-gate.txt`

AC-13 — the changed files satisfy the `gateway_backend` VALIDATION_PROFILE's
path-ownership allowlist

TEST: ran the same check `VALIDATOR-CHECK.yml`'s "Enforce Path Ownership
Guard" step runs — `node scripts/ci/validator-path-guard.cjs
<changed-files> gateway_backend <pr-body>` — locally, before pushing.
Output: `outputs/path-ownership-guard.txt`

---

## What could NOT be verified from this session, and why

**No live/staging exercise of the actual fix.** Per this repo's absolute
governance rule, no ORB voice session may be opened as the test account on
any host/transport, live or staging — all live evidence above (the original
root-cause trace) came from read-only `oasis_events` queries, and all
interactive/audio verification used the local mock-server harness (see the
real-browser and mic/close-responsiveness acceptance criteria above), never
a real gateway/Nova session. Whoever verifies the merge should
confirm on staging: tap a guided-topic session, let it run past turn 1,
force a disconnect (e.g. airplane mode toggle), and confirm (a) no spoken
alert plays if disconnecting before any audio, and (b) the reconnect
resumes the SAME topic rather than opening generic conversation.

**Command Hub Path Ownership Guard (`scripts/ci/command-hub-ownership-guard.js`,
VTID-0302) also required a change** — added `VTID-03746` to its
`ALLOWED_VTID_PATTERN`, following the exact precedent of every prior
`orb-widget.js` change (VTID-03745, VTID-03727, VTID-03706, ...). This file
is outside VALIDATOR-CHECK's REMIT (governed by a separate workflow,
`COMMAND-HUB-GUARDRAILS.yml`) so it is not part of this evidence pack's own
AC list, but is disclosed here since it's a necessary companion change in
the same PR.
