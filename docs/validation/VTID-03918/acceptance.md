# VTID-03918 — Operator chat mic: fix stuck-red dictation with no transcription

## Report

User report (verbatim), after VTID-03910/VTID-03911 shipped and made the
mic's red/neutral toggle actually visible for the first time: "I tested the
microphone. It doesn't work. Before, it worked. Now, whatever you did, it
doesn't work. I press the microphone, and it turns red, but it doesn't
listen to me. I press it again. It goes back to a neutral color, which
means the on/off switch works, but it does not react to my speech. Check
what's happening, what you have damaged, and fix it."

## Investigation

VTID-03910/VTID-03911 were CSS-only (`styles.css`) — neither touched
`app.js`'s dictation logic (`startOperatorDictation`/`stopOperatorDictation`/
`operatorDictationSupported`), which has been byte-for-byte unchanged since
VTID-03907 first shipped it. Read the full dictation lifecycle end to end:
`onresult`/`onerror`/`onend` handlers, the mic button's `onclick`, every
`stopOperatorDictation()` call site (send message, backdrop close, X close),
and the polling/re-render paths near the Operator overlay — none reveal a
CSP issue (no `connect-src` restriction was ever relevant here: Chrome's
Web Speech API network call is browser-process-mediated, not a page-level
fetch/XHR/WebSocket subject to the page's CSP) and none show a regression
introduced by the CSS-only VTID-03910/VTID-03911 diff.

## Root cause

`startOperatorDictation()` called `recognition.start()` **unguarded**, and
set the active state/class **before** that call:

```js
operatorSpeechRecognition = recognition;
state.chatDictationActive = true;
if (micBtn) micBtn.classList.add('chat-mic-btn--active');
recognition.start();   // <- no try/catch
```

If `recognition.start()` throws synchronously (e.g. `InvalidStateError`
from a leftover/stale recognition session) — or if it succeeds but then
fires an async `onerror` with a code like `not-allowed`/`service-not-allowed`
(mic permission denied/blocked) or `audio-capture` (no mic device) — the
only feedback was a `console.warn()` nobody sees. Worse, in the synchronous-
throw case, the active class/state were already applied before the throw,
so the button was stuck visually red with no live recognition behind it —
exactly "turns red, never reacts to speech, only a second manual press
(which routes to `stopOperatorDictation()` since `chatDictationActive` is
still true) turns it neutral again." This defect predates VTID-03910/
VTID-03911 (it has existed since VTID-03907) — it was invisible before only
because the mic never visibly turned red at all (the VTID-03911 bug), so
this was very plausibly never really exercised end-to-end until now.

## Fix

1. `recognition.start()` is now wrapped in `try/catch`; active state/class
   are set only **after** `start()` has actually succeeded. A thrown
   `start()` is caught, logged, and surfaced to the user via `showToast()`
   instead of leaving the button silently stuck red.
2. `recognition.onerror` now also calls `showToast(operatorDictationErrorMessage(event.error), 'error')`
   alongside the existing `console.warn`, so every async failure — denied
   mic permission, no mic device, network loss, no-speech timeout, or any
   other code — is explained to the user instead of failing silently.
3. New `operatorDictationErrorMessage(errorCode)` maps the real Web Speech
   API error codes (`not-allowed`, `service-not-allowed`, `audio-capture`,
   `network`, `no-speech`, and a generic fallback) to a human-readable
   reason.

## Acceptance Criteria

AC-1 — `recognition.start()` is called inside a `try/catch`, and
`state.chatDictationActive = true` / the `chat-mic-btn--active` class are
only applied after that call succeeds, never before.

TEST: `outputs/jest-new-suite.txt` — "VTID-03918" block, cases 1-2.

AC-2 — a thrown `start()` is caught, cleaned up (no dangling active
state/class), and surfaced via `showToast(..., 'error')` — not just a
console log nobody sees.

TEST: `outputs/jest-new-suite.txt` — "VTID-03918" block, case 3.

AC-3 — `recognition.onerror` surfaces a human-readable reason via
`showToast(operatorDictationErrorMessage(event.error), 'error')` for every
async failure code (permission denied, no mic device, network loss,
no-speech), in addition to the existing `console.warn`.

TEST: `outputs/jest-new-suite.txt` — "VTID-03918" block, cases 4-5.

## Verification

- `tsc --noEmit`: clean (`outputs/tsc-noemit.txt`).
- New suite: `outputs/jest-new-suite.txt` — 29/29 passing (24 pre-existing
  VTID-03906/07/08/10/11 cases untouched and still green, plus 5 new
  VTID-03918 cases).
- Full gateway suite (regression check): `outputs/jest-full-suite.txt` —
  900/901 suites (1 pre-existing skip), 14,952 tests passing, 0 failures.
- Build gate: `outputs/npm-build.txt` — exit 0.
- CSP Governance Gate (local pre-flight): no CSP header touched by this
  change; `git diff origin/main -- services/gateway/src/frontend/` scanned
  via `validator-path-guard.cjs --csp-added-lines` — zero hits.

## What this does NOT confirm

This session has no live authenticated Command Hub browser session and no
microphone to reproduce the exact failure end-to-end. The fix is verified
structurally (the unguarded-`start()`/stuck-active-state defect is real
and now closed, and every failure path now produces a visible reason
instead of silence) — not yet confirmed against a real browser+mic session
showing dictation actually transcribing speech into the chat input. If the
real root cause on the reporter's machine turns out to be something this
fix cannot see from source alone (e.g. an OS-level mic block, or a browser
extension interfering) — the new `showToast()` messages should now name it
directly (e.g. "Voice dictation needs microphone permission...") instead of
leaving a silently-dead red button, which is itself the actionable next
signal if the mic still doesn't work after this ships.

## OASIS impact

OASIS_IMPACT: no — client-side JS fix only.
