# VTID-03783 — Overlay frozen on "Session ended — app was in the background"

## Report (verbatim)

> now it finished teaching, and I see this screen afterwards without being
> able to switch it off. Close button doesn't react. No Well done drawer,
> no that step marked as done.

(Two screenshots attached: an earlier "Tap the orb to reconnect" stuck
state, then the final state — orb sphere, active/unmuted mic icon, caption
"Session ended — app was in the background.", X button visible but
reported unresponsive.)

## Investigation

The caption text is a direct, exact match for the `sessionEndedBackground`
locale key (`orb-widget.js`, the per-locale `Record<lang,string>` including
`en: 'Session ended — app was in the background.'`) — this pins the report
to `_startBackgroundWatchdog()`'s kill branch, not a different failure
path.

Read `_startBackgroundWatchdog()`: it detects OS-level backgrounding via
`setTimeout` drift (no Page Visibility API — unreliable on some Android
WebViews) and, once `drift > BG_KILL_DRIFT_MS` (30s), was calling:

```js
_setStatus(_caption('sessionEndedBackground'));
_sessionStop();
return;
```

This is the exact `_sessionStop()`-instead-of-`_hide()` anti-pattern
VTID-03778 already found and fixed for the `session_ended` WS message
handler in this same file: `_sessionStop()` tears down media/SSE/network
state but never touches overlay visibility or DOM display — only `_hide()`
does that, plus it clears the guided-topic lifecycle flags
(`_s.guidedTopic`, `_s._guidedTopicTeachingEnded`, etc.). Calling
`_sessionStop()` alone leaves the overlay on-screen forever, frozen on
whatever caption was last set — here, "Session ended — app was in the
background."

Read `_hide()` (unconditional, safe to call even after `_sessionStop()`
has already run once — confirmed by reading its body, it does not assume
an active session) and confirmed the X close button
(`closeBtn.addEventListener('click', _hide);`) is unconditionally bound
with no gating on session state. This means the X button was never
actually broken — it correctly calls `_hide()` on click. The reported
"Close button doesn't react" is the same frozen-overlay symptom described
differently: once the overlay is showing a stale post-teardown state with
no live session behind it, whatever the X does downstream of `_hide()` may
interact confusingly with already-torn-down state, and — more
importantly — the fix here removes the frozen intermediate screen
entirely, so there is no stuck screen left for the user to need to press X
on.

## Root cause

`_startBackgroundWatchdog()`'s kill branch called `_sessionStop()`
directly instead of `_hide()`, freezing the overlay on the
"Session ended — app was in the background" caption forever, with no
Well-done drawer and no step marked done — because the guided-topic
completion teardown was never reached (correctly — see below).

## Fix

`_startBackgroundWatchdog()`'s kill branch now calls `_hide()` instead of
`_sessionStop()` — the same full, honest teardown every other close path
in this file uses (the X button, the `session_ended` handler fixed by
VTID-03778, the guided-topic completion path). No new UI, caption, or
mechanism was invented.

**Deliberately does NOT call `_endGuidedTopicTeaching()`.** A background
suspension is not a reliable "the lesson finished" signal — the app may
have been backgrounded mid-sentence, mid-lesson, at any point. Awarding
step-completion credit here would invent a completion signal the product
does not define, which the platform owner's original spec for this whole
VTID chain explicitly forbids ("user manually closes != teaching
successfully completed unless product logic explicitly defines it that
way"). A background-kill closes the overlay honestly without marking
anything done — the user can re-tap the topic from My Journey to resume.

## Acceptance Criteria

AC-1 — The background-watchdog kill branch still detects backgrounding via
setTimeout drift (unchanged), and still ends the session rather than
leaving it running.

TEST: `orb-widget-background-watchdog.test.ts` — "detects backgrounding
via setTimeout drift, not the Visibility API", "ends the session instead
of leaving it running when backgrounding is detected"

AC-2 — The kill branch calls `_hide()` — the same full teardown a real
close uses — not the bare `_sessionStop()` that leaves the overlay frozen.

TEST: same file — "calls _hide() — the same full, honest teardown a real
close uses — not the bare _sessionStop() that leaves the overlay frozen"

AC-3 — The kill branch does NOT call `_endGuidedTopicTeaching()` — a
background-kill must not auto-mark a step done.

TEST: same file — "does NOT call _endGuidedTopicTeaching() — a
background-kill must not auto-mark a step done"

AC-4 — Every other existing behavior of `_startBackgroundWatchdog()` is
unchanged: reschedule-while-visible gating on `_s.overlayVisible` (not
`_s.active`), the 5s check interval / 30s kill threshold constants,
`_stopBackgroundWatchdog()` clearing the timer, and start/stop wiring on
`_show()`/`_sessionStop()`.

TEST: same file — "reschedules itself while the overlay is open, not
gated on _s.active", "uses a 5s check interval and a 30s kill threshold",
"_stopBackgroundWatchdog clears the timer", "starts on overlay open
(_show) and stops on session teardown (_sessionStop)"

AC-5 — `node --check` is clean.

TEST: `outputs/node-check.txt` — exit 0.

AC-6 — `tsc --noEmit` is clean.

TEST: `outputs/tsc-noemit.txt` — exit 0 (empty output).

AC-7 — The fix is mutation-verified: reverting `_hide()` back to
`_sessionStop()` fails exactly 1 test ("calls _hide()..."), and the other
7 tests in the same suite (including "does NOT call
_endGuidedTopicTeaching()") stay green. Clean restore confirmed via
`diff`.

TEST: `commands.log` — mutation testing section.

AC-8 — The full gateway suite is green.

TEST: `outputs/jest-full-suite.txt`.

## Deliberately NOT attempted

- **No change to the X close button itself.** It was already correctly
  wired to `_hide()` unconditionally — the reported unresponsiveness is
  the same frozen-overlay symptom, not a separate defect in the button's
  own event handler. Fixing the root freeze removes the stuck screen the
  user would otherwise need to press X on.
- **No automatic step-completion credit for a background-kill.** See "Fix"
  above — this is a deliberate product decision, not an oversight: a
  suspended app is not evidence the lesson was actually finished.
- **Not independently confirmed against live traffic / a real device.**
  This session has no live-browser or device verification path. The
  reliable next signal is the platform owner's own retest: background the
  app (or wait ~30s+ for the OS to suspend it) during a My Journey
  session and confirm the overlay closes cleanly instead of freezing on
  the "Session ended — app was in the background" caption. I could not
  100% mechanically rule out a separate CSS/tap-target issue with the X
  button without live-device access — if the button still doesn't respond
  after this fix ships, that would point to a different, UI-layer defect
  worth a fresh report.
