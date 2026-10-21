# VTID-03953 — Command Hub Operator Console: double-click rename closes itself immediately

Reported directly after VTID-03949 shipped: "Double-click to rename does
not work. I double-click, it opens or activates, but then switches back,
like shutting down the editable space. It turns it on, but then
immediately shuts it down, so fix this. I'm not able to edit or rename the
title."

## Root cause

`_renderAppCore()` rebuilds the whole app tree on every `renderApp()` call
(ticker/heartbeat SSE pollers included) via `root.innerHTML = ''`. Removing
a *focused* element from the DOM fires a synchronous, involuntary native
`blur` event on it as part of the removal — standard browser behavior, not
a bug in the removal itself. VTID-03949's rename `<input>` had:

```js
input.onblur = () => commitRenamingOperatorThread();
```

with no way to tell that involuntary removal-blur apart from a genuine
user blur (clicking away, Tab, switching threads). So the very first
background re-render after opening a rename — from any poller, which fire
frequently in this UI — destroyed the focused input, fired blur,
`commitRenamingOperatorThread()` ran, `state.operatorRenamingThreadId`
was nulled, and the *same* render pass (still mid-flight, past the
`innerHTML = ''` line) then rebuilt the DOM from that now-cleared state —
rendering the plain span instead of the input. Net effect: the input opens
and closes within a single synchronous call stack, matching the report
exactly ("it turns it on, but then immediately shuts it down").

This codebase already has an established, working pattern for exactly this
class of bug — `.chat-textarea`/`.task-spec-textarea` capture their focus
state before `root.innerHTML = ''` and restore it afterward
(VTID-0526-E / DEV-COMHU-2025-0015) — but VTID-03949's new rename input was
never wired into it.

## Change

- New module-level `_renameBlurSuppressed` (`app.js`): bracketed around
  exactly the `root.innerHTML = ''` call in `_renderAppCore()`. The rename
  input's `onblur` now checks it and no-ops when true, so only a genuine
  user-initiated blur still commits.
- New module-level `_renamePreserveFocusPending`: tells
  `renderEditableThreadTitle()` this particular rebuild is restoring an
  already-focused input (so it must skip its auto `focus()+select()`,
  which would otherwise select-all over the top of the precise cursor
  restore below) rather than a fresh double-click open.
- `_renderAppCore()` captures `{threadId, selectionStart, selectionEnd}`
  from `document.activeElement` (not `querySelector`, since the same
  input class can render twice at once — sidebar row + title bar, when
  renaming the active thread) before the destructive rebuild, and restores
  focus + exact cursor position via `requestAnimationFrame()` afterward —
  mirroring the existing `savedChatFocus`/`savedSpecFocus` blocks exactly.

## Acceptance Criteria

AC-1: A background re-render (any `renderApp()` call, e.g. from a
ticker/heartbeat poller) while the rename input is focused no longer
commits/closes the edit.
TEST: `services/gateway/test/vtid-03949-operator-sessions-sidebar-rename.test.ts`
  — "_renderAppCore() sets _renameBlurSuppressed only around the
  root.innerHTML = '' call that would otherwise fire the involuntary
  blur".

AC-2: The rename input still commits on a genuine blur (user clicks away,
tabs out, or switches threads), on Enter, and still cancels on Escape.
TEST: `services/gateway/test/vtid-03949-operator-sessions-sidebar-rename.test.ts`
  — "the rename input commits on Enter, cancels on Escape, and commits on
  a genuine blur".

AC-3: Focus and the exact cursor/selection position are restored on the
freshly rebuilt input after a background re-render interrupts an
in-progress rename.
TEST: `services/gateway/test/vtid-03949-operator-sessions-sidebar-rename.test.ts`
  — "_renderAppCore() restores rename-input focus and exact cursor
  position after rebuild, gated on the same thread still being renamed".

AC-4: The restored input does not get its text select-all'd on top of the
precise cursor restore (which would let the next keystroke wipe the whole
title) — only a fresh double-click open gets select-all.
TEST: `services/gateway/test/vtid-03949-operator-sessions-sidebar-rename.test.ts`
  — "renderEditableThreadTitle() skips the auto-select-all when restoring
  an already-focused input...".

AC-5: Focus/selection capture uses `document.activeElement`, not
`querySelector`, since the rename input can exist twice simultaneously
(sidebar row + title bar, when renaming the active thread).
TEST: `services/gateway/test/vtid-03949-operator-sessions-sidebar-rename.test.ts`
  — "_renderAppCore() captures the rename input focus/selection via
  document.activeElement...".

AC-6: No JavaScript syntax regression in the Command Hub bundle.
TEST: `node --check services/gateway/src/frontend/command-hub/app.js` and
  `node --check services/gateway/dist/frontend/command-hub/app.js` (both
  run as part of `commands.log`, and by CI's own Bundle Syntax Gate,
  VTID-01011). Golden Fingerprint Check also passes locally.

## Not verified live in a browser

No Command Hub admin login credentials in this session (unchanged from
every prior PR on this surface — see `../VTID-03949/outputs/README.md`).
Verification here is static/source-level plus a local build, syntax
check, and Golden Fingerprint check. `outputs/` is present (Evidence Pack
Gate requirement) — see its own `README.md`.
