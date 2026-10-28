# VTID-03949 — Command Hub Operator Console: fullscreen, sessions sidebar, rename

Requested directly against a screenshot of the live Command Hub Operator
Console: (1) the fullscreen toggle only produced a bigger pop-up, not real
fullscreen; (2) the thread-switcher dropdown was bad UX, covering the
transcript while open and showing only one session at a time — wanted as
a persistent Claude-Code-style sessions sidebar instead; (3) no way to
rename a session's title by double-clicking it, in either the main view
or the sidebar, unlike Claude Code.

## Change

- `.operator-overlay--fullscreen` (`styles.css`) is now literal
  100vw/100vh with `border-radius: 0`, replacing VTID-03905/VTID-03910's
  deliberate 2cm-inset "bigger popup" design.
- New `renderOperatorSessionsSidebar()` (`app.js`) lists every
  conversation thread (most-recently-updated first), click to switch,
  active thread highlighted — rendered alongside `renderOperatorChat()`
  inside a new `.operator-chat-layout` flex row, replacing the old
  `<select>` thread dropdown. A new title bar above the transcript
  carries a sidebar show/hide toggle, the active session's own title, and
  "+ New".
- New shared `renderEditableThreadTitle()` helper swaps a thread's title
  for an inline text input on double-click — used both by each sidebar
  row and the title bar, so renaming behaves identically in both places.

## Acceptance Criteria

AC-1: The fullscreen toggle produces real edge-to-edge fullscreen
(100vw/100vh, no border-radius), not an inset "bigger popup".
TEST: `services/gateway/test/vtid-03906-08-operator-scroll-mic-fullscreen.test.ts`
  — "VTID-03949: fullscreen is real edge-to-edge fullscreen, not a bigger
  popup" (2 tests).

AC-2: The thread dropdown is replaced by a persistent sessions sidebar
listing every conversation, most-recently-updated first, with the active
session highlighted and click-to-switch.
TEST: `services/gateway/test/vtid-03949-operator-sessions-sidebar-rename.test.ts`
  — "renderOperatorSessionsSidebar() lists every thread, most-recently-
  updated first, and switches on click".

AC-3: An empty thread list shows a plain empty state instead of a blank
sidebar.
TEST: `services/gateway/test/vtid-03949-operator-sessions-sidebar-rename.test.ts`
  — "an empty thread list renders a plain empty state instead of a blank
  sidebar".

AC-4: The sidebar can be shown/hidden via a toggle in the chat title bar.
TEST: `services/gateway/test/vtid-03949-operator-sessions-sidebar-rename.test.ts`
  — "the sidebar can be collapsed via state.operatorSessionsSidebarCollapsed,
  toggled from the chat title bar".

AC-5: A session's title can be renamed by double-clicking it, both in the
sidebar and in the title bar above the transcript.
TEST: `services/gateway/test/vtid-03949-operator-sessions-sidebar-rename.test.ts`
  — "is used both in the sessions sidebar and in the chat title bar above
  the transcript", plus "renderEditableThreadTitle() shows a plain span
  with a dblclick handler when not renaming" and "...swaps to a text
  input while state.operatorRenamingThreadId matches the thread".

AC-6: The rename input commits on Enter or blur, cancels on Escape, and
never saves a blank title.
TEST: `services/gateway/test/vtid-03949-operator-sessions-sidebar-rename.test.ts`
  — "the rename input commits on Enter, cancels on Escape, and commits on
  blur" and "commitRenamingOperatorThread() discards a blank/whitespace-
  only draft instead of saving an empty title".

AC-7: Typing in the rename input never triggers a full-app re-render
itself (so a background poller's own re-render can't wipe an in-progress
edit), matching the existing `.chat-textarea` convention.
TEST: `services/gateway/test/vtid-03949-operator-sessions-sidebar-rename.test.ts`
  — "the input's own oninput syncs state without calling renderApp()
  itself...".

AC-8: No JavaScript syntax regression in the Command Hub bundle.
TEST: `node --check services/gateway/src/frontend/command-hub/app.js` and
  `node --check services/gateway/dist/frontend/command-hub/app.js` (both
  run as part of `commands.log`, and by CI's own Bundle Syntax Gate,
  VTID-01011). Golden Fingerprint Check also passes locally.

## Not verified live in a browser

No Command Hub admin login credentials in this session (unchanged from
every prior PR on this surface — see
`../VTID-03925/outputs/README.md`). Verification here is static/
source-level plus a local build, syntax check, and Golden Fingerprint
check. `outputs/` is present (Evidence Pack Gate requirement) — see its
own `README.md`.
