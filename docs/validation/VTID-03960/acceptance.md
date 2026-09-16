# VTID-03960 — Command Hub Operator Console: session "..." menu (Rename/Share/Archive/Delete)

Requested directly against a screenshot of the Claude Code product's own
sessions-sidebar "..." menu: "look at how claude code solved this: make it
the same way, when clicking the dots, it should show for now: Rename,
Share, Archive, Delete." No delete/archive/share mechanism existed for
Operator Console threads at all before this — only rename (VTID-03949).

## Change

- New `renderThreadMenuButton()`/`renderThreadMenu()` (`app.js`) — a "..."
  button per sidebar row, opening a dropdown with Rename/Share/Archive/
  Delete (Unarchive replaces Archive on an already-archived thread).
  Click-outside-to-close mirrors this file's existing version-dropdown
  pattern (`renderHeader()`'s `isVersionDropdownOpen` handling).
- `deleteOperatorThread()` — removes the thread and its saved history
  permanently, gated on `confirm()` (this file's established convention
  for destructive actions). Switches to the next most-recent thread, or
  starts a new one, if the deleted thread was active.
- `archiveOperatorThread()`/`unarchiveOperatorThread()` — a non-destructive
  `archived` flag. Archived threads are filtered out of the default
  sidebar list but never deleted, reachable via a "Show N archived" toggle,
  so archiving can never silently orphan a conversation.
- `shareOperatorThread()` — copies a `?operator_thread=<id>` link to the
  clipboard. Both `initOperatorChatSession()` and the `DOMContentLoaded`
  boot sequence now honor that param (preselecting the thread / auto-
  opening the Operator Console). Operator threads are `localStorage`-only
  (VTID-03822, never synced across devices/users), so this is a
  same-browser reopen link, not a cross-user share — documented inline in
  `shareOperatorThread()`'s own comment.
- `renderOperatorThreadRow()` extracted from `renderOperatorSessionsSidebar()`
  so the same row (title, meta, menu button) renders for both the active
  and archived sections.
- `openOperatorConsole()` extracted from the header OPERATOR pill's
  `onclick` so the boot-time deep-link auto-open reuses the identical
  open sequence instead of duplicating it.

## Acceptance Criteria

AC-1: Each sessions-sidebar row shows a "..." button that opens a menu
listing Rename, Share, Archive (or Unarchive if already archived), and
Delete, in that order.
TEST: `services/gateway/test/vtid-03960-operator-thread-menu.test.ts`
  — "renderThreadMenu() renders exactly Rename/Share/Archive/Delete, in
  that order, for a non-archived thread" and "...swaps Archive for
  Unarchive when thread.archived is true".

AC-2: Delete asks for confirmation, then removes the thread and its saved
history permanently, and safely hands off the active thread if it was the
one deleted.
TEST: `services/gateway/test/vtid-03960-operator-thread-menu.test.ts`
  — the three `deleteOperatorThread()` tests.

AC-3: Archive hides a thread from the default list without deleting it,
and it stays reachable via an "N archived" toggle; Unarchive reverses it.
TEST: `services/gateway/test/vtid-03960-operator-thread-menu.test.ts`
  — the `archiveOperatorThread()`/`unarchiveOperatorThread()` tests and
  "sidebar filters out archived threads by default" tests.

AC-4: Share copies a link that, opened in the same browser, reopens that
exact thread — not a dead/decorative action.
TEST: `services/gateway/test/vtid-03960-operator-thread-menu.test.ts`
  — "shareOperatorThread()" tests and "the deep link is actually honored,
  not just produced" tests.

AC-5: The per-thread "..." menu button click and each menu item click
never bubble up to the row's own click handler (which would switch
threads), and selecting an item closes the menu first.
TEST: `services/gateway/test/vtid-03960-operator-thread-menu.test.ts`
  — "renderThreadMenuButton() toggles..." and "each menu item click
  closes the menu before running its own action".

AC-6: No regression to the existing sidebar rendering, rename mechanism,
or fullscreen/copy/timestamp features this surface already had.
TEST: `services/gateway/test/vtid-03949-operator-sessions-sidebar-rename.test.ts`,
  `services/gateway/test/vtid-03822-operator-chat-threads.test.ts`,
  `services/gateway/test/vtid-03906-08-operator-scroll-mic-fullscreen.test.ts`,
  `services/gateway/test/vtid-03947-message-copy-timestamp.test.ts` — all
  passing (97/97 across the 5 targeted suites, see `commands.log`).

AC-7: No JavaScript syntax regression in the Command Hub bundle.
TEST: `node --check services/gateway/src/frontend/command-hub/app.js` and
  `node --check services/gateway/dist/frontend/command-hub/app.js` (both
  run as part of `commands.log`, and by CI's own Bundle Syntax Gate,
  VTID-01011). Golden Fingerprint Check also passes locally.

## Not verified live in a browser

No Command Hub admin login credentials in this session (unchanged from
every prior PR on this surface — see `../VTID-03953/outputs/README.md`).
Verification here is static/source-level plus a local build, syntax
check, and Golden Fingerprint check. `outputs/` is present (Evidence Pack
Gate requirement) — see its own `README.md`.
