# VTID-03966 — Command Hub Operator Console: rename input closes itself instantly when renaming the ACTIVE thread

Reported live, after VTID-03953 (which fixed a *different* rename-closing
defect) had already shipped and been verified on staging: "your 4th
attempt to make rename work does still not work... rename dont work. not
in kebab dropdown and also not when doubleclicking the title both dont
work." The user explicitly asked for real visual verification ("you
should make screenshots and click yourslef to see the bug") rather than
another source-level-only fix.

## Root cause — found by actually running the code

This session had no Command Hub admin credentials, but the rename
mechanism is 100% client-side DOM/state logic with no network calls, so it
was reproducible locally: served `services/gateway/src/frontend/` with a
plain static HTTP server, loaded the real, unmodified `app.js` in a
headless Chromium via Playwright, seeded `state.authToken` +
`state.operatorThreads` directly (bypassing the auth-gated boot sequence,
which this bug has nothing to do with), and exercised the real
`startRenamingOperatorThread()` / DOM double-click / kebab-menu-click
paths.

**Confirmed live in the browser:** renaming a genuinely non-active thread
(rendered once) worked correctly and stayed open. Renaming the ACTIVE
thread — which renders `renderEditableThreadTitle()` **twice** in the same
pass, once in the sidebar row and once in the title bar above the
transcript (a deliberate VTID-03949 design, "shared... so both places
behave identically") — closed itself within a single animation frame,
every time, regardless of entry point (double-click title, or kebab menu
→ Rename; both call the same `startRenamingOperatorThread()`).

Instrumented directly: `state.operatorRenamingThreadId` was correctly set
to the target thread id immediately after the call, but became `null`
again one `requestAnimationFrame` later, with `document.querySelectorAll(
'.chat-session-title-input').length` measured at 2 just before that reset.

The mechanism: both rendered `<input>` instances independently scheduled
their own `setTimeout(() => { input.focus(); input.select(); }, 0)`.
Whichever macrotask fires second calls `.focus()` on its own input, which
— because only one element can hold focus — steals focus away from the
first input. That is a **genuine** DOM blur (the user did nothing; a
sibling element took focus), not the involuntary *removal*-blur
VTID-03953's `_renameBlurSuppressed` flag guards against (that flag is
only ever `true` bracketed around `root.innerHTML = ''`, and these
`setTimeout(0)` callbacks fire on a later macrotask, well after that
render pass and its flag window have already finished). So the first
input's unconditional `onblur` fires `commitRenamingOperatorThread()`,
which nulls `state.operatorRenamingThreadId` and re-renders back to the
plain, non-editable title — the "opens, then immediately shuts down"
symptom, for both reported entry points, since both funnel into the same
underlying render path.

## Change

`app.js` only. New module state `_renameAutoFocusClaimedForThreadId`,
reset to `null` once per `_renderAppCore()` pass (alongside the existing
`_renamePreserveFocusPending` reset). `renderEditableThreadTitle()`'s
auto-focus `setTimeout` is now gated on `!_renamePreserveFocusPending &&
_renameAutoFocusClaimedForThreadId !== thread.id` — the first instance
built during a pass claims the thread id (before scheduling its
`setTimeout`, so a same-pass second instance for the same thread
immediately sees the claim) and gets the deferred focus/select call; a
second instance for the same thread id skips scheduling its own, so the
two can no longer fight over focus. Purely additive — the VTID-03953
blur-suppression and preserve-focus-restore mechanism is untouched.

## Acceptance Criteria

AC-1: Double-clicking the ACTIVE thread's title (sidebar row or title
bar) opens the rename input and it stays open — it does not close itself
within the same frame.
TEST: `services/gateway/test/vtid-03966-operator-rename-dual-instance-focus.test.ts`
  — the `_renameAutoFocusClaimedForThreadId` module-state and
  render-guard tests.
UI: `docs/validation/VTID-03966/outputs/repro-fixed-01-active-rename-open.png`
  — a real headless-Chromium screenshot, taken via Playwright driving the
  actual `app.js`, showing both the sidebar-row input and the title-bar
  input open simultaneously after a double-click on the active thread's
  title, neither closed.

AC-2: Typing into the focused instance is preserved, and pressing Enter
commits the new title to the thread (visible in both the sidebar row and
the title bar after commit).
UI: `docs/validation/VTID-03966/outputs/repro-fixed-02-active-rename-typed.png`
  (mid-typing, both inputs still open) and
  `repro-fixed-03-active-rename-committed.png` (post-Enter: title bar
  reads "Renamed active thread via dblclick", sidebar row reads the same).

AC-3: The kebab-menu "Rename" item opens the same working, non-self-
closing input for the active thread (both reported entry points fixed by
the same root-cause fix, not two separate patches).
TEST: `services/gateway/test/vtid-03966-operator-rename-dual-instance-focus.test.ts`
  — "the sidebar row and title bar both call renderEditableThreadTitle
  with the SAME shared function" (both entry points converge on the one
  fixed code path).

AC-4: Renaming a non-active thread (single rendered instance, no
sibling to race against) still works exactly as before — no regression.
TEST: `services/gateway/test/vtid-03966-operator-rename-dual-instance-focus.test.ts`
  and confirmed live with the Playwright harness (`commands.log`):
  single-instance rename opened, accepted typed input, and committed on
  Enter with no interference.

AC-5: The existing VTID-03953 fix (a background poller's renderApp()
mid-edit must not close the rename) is still intact — this fix is
additive, not a rewrite.
TEST: `services/gateway/test/vtid-03949-operator-sessions-sidebar-rename.test.ts`
  (updated assertion for the widened guard condition) and confirmed live
  with the Playwright harness: a simulated background `renderApp()` call
  mid-edit left the input open and focused, same as before this fix.

AC-6: No JavaScript syntax regression in the Command Hub bundle.
TEST: `node --check services/gateway/src/frontend/command-hub/app.js` and
  `node --check services/gateway/dist/frontend/command-hub/app.js` (both
  run as part of `commands.log`, and by CI's own Bundle Syntax Gate,
  VTID-01011). Golden Fingerprint Check also passes locally.

## Verified with real browser interaction, not source-reading alone

Unlike every prior PR on this surface, this fix was verified against the
**actual running application** in a real (headless) browser — see
`commands.log` for the exact reproduction and fix-confirmation steps, and
`outputs/` for the screenshots. This session still has no Command Hub
admin login for `preview-aws-gateway.vitanaland.com` (see
`../VTID-03960/outputs/README.md`), so the local static-server harness —
not a live gateway session — is what made real interaction possible for
this specific, 100%-client-side bug.
