# VTID-03947 — Acceptance

Command Hub Operator Console: add a copy-to-clipboard icon under each chat
message and a relative timestamp (Claude Code style: "3h ago", absolute
time on hover), replacing the old always-absolute HH:MM timestamp.

Requested directly: "add in the command hub operator under each session the
copy paste icon for easy copy of the response block and add the timestamp
like claude code does in the screenshot".

## AC-1: A copy icon is rendered under every chat message, sent and reply alike

TEST: `test/vtid-03947-message-copy-timestamp.test.ts` — "renders a
message-meta row per message instead of the old bare timestamp div" and
"the copy button copies msg.content via navigator.clipboard.writeText".

## AC-2: Clicking the copy icon copies the message's raw content to the clipboard

TEST: `test/vtid-03947-message-copy-timestamp.test.ts` — "the copy button
copies msg.content via navigator.clipboard.writeText".

## AC-3: The copy icon gives visible confirmation on click (swaps to a checkmark, then back)

TEST: `test/vtid-03947-message-copy-timestamp.test.ts` — "the copy button
swaps to the check icon and back, so the click gives visible confirmation".

## AC-4: A missing/blocked clipboard API degrades silently, never throws

TEST: `test/vtid-03947-message-copy-timestamp.test.ts` — "a missing/failing
clipboard API is a silent no-op, not a thrown error".

## AC-5: Each message shows a relative timestamp ("3h ago") with the absolute time available on hover

TEST: `test/vtid-03947-message-copy-timestamp.test.ts` — "the timestamp
span shows a relative time via the existing formatRelativeTime() helper,
with the absolute time as a hover title".

## AC-6: Every code path that adds to state.chatMessages (live send, and thread restore from localStorage) carries the raw epoch the relative-time formatter needs

TEST: `test/vtid-03947-message-copy-timestamp.test.ts` — "every
state.chatMessages.push({...}) block within sendChatMessage() carries a
ts: field" and "switchOperatorThread() and initOperatorChatSession()
restore ts from the saved thread history".

## AC-7: No duplicate relative-time helper introduced

TEST: `test/vtid-03947-message-copy-timestamp.test.ts` — "does not
introduce a second formatRelativeTime-shaped helper (reuses the existing
one)". This file already had two same-named `formatRelativeTime()`
declarations from an earlier, incompletely-fixed duplication
(`fix-duplicate-formatRelativeTime` marker in
`scripts/ci/command-hub-ownership-guard.js`) — reusing the existing helper
rather than adding a third avoids making that worse.

## Build / type-check

CURL: n/a — client-side-only change, no new/changed route.

`tsc --noEmit` clean (see `commands.log`). `npm run build` clean;
`node --check` passes on both `src/frontend/command-hub/app.js` and the
copied `dist/frontend/command-hub/app.js` (byte-identical — `diff` empty).
Golden Fingerprint Check passes locally (`node
scripts/ci/command-hub-golden-fingerprint.js`).

## Not verified live in a browser

No Command Hub admin login credentials in this session (unchanged from
VTID-03917/VTID-03925's own PRs — see
`docs/validation/VTID-03925/outputs/README.md`). Verification here is
static/source-level plus a local build + syntax + fingerprint check. See
`outputs/README.md`.
