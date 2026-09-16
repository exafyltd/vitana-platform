# VTID-03947 — Command Hub Operator Console: copy icon + relative timestamp

Requested directly: "add in the command hub operator under each session the
copy paste icon for easy copy of the response block and add the timestamp
like claude code does in the screenshot".

## Change

Each chat bubble in the Operator Console (`renderOperatorChat()`, `app.js`)
now renders a `.message-meta` row beneath it instead of the old always-
absolute `HH:MM` timestamp div:

- A copy-to-clipboard icon — copies the message's raw content via
  `navigator.clipboard.writeText`, swaps to a checkmark for 1.5s as visible
  confirmation, and silently no-ops if the Clipboard API is unavailable.
- A relative timestamp ("3h ago", Claude Code style) with the exact
  absolute time available on hover via the `title` attribute.

Every push onto `state.chatMessages` now also carries a raw `ts` epoch
(the pre-existing `timestamp` field is a locale-time-only string that
relative-time formatting can't derive elapsed time from), and reuses the
file's own existing `formatRelativeTime()` helper rather than adding a
third near-duplicate of it.

## Acceptance Criteria

AC-1: A copy icon is rendered under every chat message, sent and reply alike.
TEST: `services/gateway/test/vtid-03947-message-copy-timestamp.test.ts`
  — "renders a message-meta row per message instead of the old bare
  timestamp div" and "the copy button copies msg.content via
  navigator.clipboard.writeText".

AC-2: Clicking the copy icon copies the message's raw content to the clipboard.
TEST: `services/gateway/test/vtid-03947-message-copy-timestamp.test.ts`
  — "the copy button copies msg.content via navigator.clipboard.writeText".

AC-3: The copy icon gives visible confirmation on click (swaps to a
checkmark, then back to the copy icon after 1.5s).
TEST: `services/gateway/test/vtid-03947-message-copy-timestamp.test.ts`
  — "the copy button swaps to the check icon and back, so the click gives
  visible confirmation".

AC-4: A missing/blocked clipboard API degrades silently — the click never
throws.
TEST: `services/gateway/test/vtid-03947-message-copy-timestamp.test.ts`
  — "a missing/failing clipboard API is a silent no-op, not a thrown
  error".

AC-5: Each message shows a relative timestamp ("3h ago") with the exact
absolute time available on hover, via the existing `formatRelativeTime()`
helper.
TEST: `services/gateway/test/vtid-03947-message-copy-timestamp.test.ts`
  — "the timestamp span shows a relative time via the existing
  formatRelativeTime() helper, with the absolute time as a hover title".

AC-6: Every code path that adds to `state.chatMessages` (a live send, and
thread restore from localStorage) carries the raw epoch the relative-time
formatter needs.
TEST: `services/gateway/test/vtid-03947-message-copy-timestamp.test.ts`
  — "every state.chatMessages.push({...}) block within sendChatMessage()
  carries a ts: field" and "switchOperatorThread() and
  initOperatorChatSession() restore ts from the saved thread history".

AC-7: No duplicate relative-time helper is introduced (this file already
carries two same-named `formatRelativeTime()` declarations from an
earlier, incompletely-fixed duplication).
TEST: `services/gateway/test/vtid-03947-message-copy-timestamp.test.ts`
  — "does not introduce a second formatRelativeTime-shaped helper (reuses
  the existing one)".

AC-8: No JavaScript syntax regression in the Command Hub bundle.
TEST: `node --check services/gateway/src/frontend/command-hub/app.js` and
  `node --check services/gateway/dist/frontend/command-hub/app.js` (both
  run as part of `commands.log`, and by CI's own Bundle Syntax Gate,
  VTID-01011). Golden Fingerprint Check also passes locally.

## Not verified live in a browser

No Command Hub admin login credentials in this session (unchanged from
VTID-03917/VTID-03925's own PRs — see
`../VTID-03925/outputs/README.md`). Verification here is static/
source-level plus a local build, syntax check, and Golden Fingerprint
check. `outputs/` is present (Evidence Pack Gate requirement) — see its
own `README.md`.
