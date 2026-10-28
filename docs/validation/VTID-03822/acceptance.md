# VTID-03822 — Operator Console chat cockpit UI

## Report

Command Hub's Operator Console chat (`renderOperatorChat()`) had three
independent gaps against its own spec: no real conversation threads (only
a single flat history — VTID-01027's `clearOperatorChatSession()`/"New
conversation" action existed but was never wired to any UI element),
markdown replies rendered as literal `**bold**`/`` `code` `` text via
`bubble.textContent`, and `toolResults`/`meta` — already pushed onto
`state.chatMessages` by `sendChatMessage()`'s response handling — were
never read by the renderer. The sibling "Live Console" surface
(`renderCommandHubLiveConsoleView()`) has the identical markdown bug
against the same `/api/v1/operator/chat` reply shape.

Per this VTID's own spec ("purely frontend, no backend dependency" — there
is no server-side conversation table to build against), threading is
implemented entirely client-side: a `localStorage`-backed thread index
(`operator_console_threads_index`) plus per-thread history keys
(`operator_console_history:<threadId>`), with a one-time, non-destructive
migration from the pre-existing single-thread storage so no existing
user's history is silently dropped by this change.

## Acceptance Criteria

AC-1 — `state` carries `operatorThreads`/`operatorActiveThreadId`, and a
`migrateOperatorHistoryToThreads()` helper wraps any pre-existing
single-thread `operator_console_history` into a first thread exactly once
(no-ops once threads already exist), preserving the existing
`conversation_id` for backend context continuity.

TEST: `test/vtid-03822-operator-chat-threads.test.ts` — the "Multi-thread
conversation state" block (7 assertions on the real source of
`migrateOperatorHistoryToThreads`/`startNewOperatorThread`/
`switchOperatorThread`/`initOperatorChatSession`).

REAL-BROWSER VERIFICATION (not just source assertions): loaded the actual
built `app.js` in headless Chromium (served at `/command-hub/app.js`, the
same path the real gateway serves it at) with a seeded legacy
`operator_console_history` + `operator_console_conversation_id` in
`localStorage`, then called the real `initOperatorChatSession()`. Result:
exactly 1 thread created, titled from the first user message
("How many tasks are scheduled?"), `operatorChatHistory`/`chatMessages`
both restored to length 2, and `operatorConversationId` preserved as the
pre-existing `legacy-conv-123` — confirming the migration is safe and the
existing backend-context-continuity mechanism (which keys off
`conversation_id`) is untouched by it.

AC-2 — `startNewOperatorThread()`/`switchOperatorThread()` create/restore
threads and re-render; a thread-switcher `<select>` + "+ New" button is
present in `renderOperatorChat()`, wired to both.

TEST: same file — "Operator chat message rendering" block's
thread-switcher assertion.

REAL-BROWSER VERIFICATION: rendered the actual `renderOperatorChat()` in
headless Chromium with 3 real threads seeded via the real
`startNewOperatorThread()` calls — the rendered `<select>` had exactly 3
`<option>`s, values matching `state.operatorThreads` ids 1:1, and
`select.value` matching `state.operatorActiveThreadId`. Clicking the real
"+ New" button (via `page.click`) increased `state.operatorThreads.length`
from 2 to 3 and, on re-render, correctly showed the new thread's empty
state ("No messages yet…") — screenshots below.

AC-3 — `sendChatMessage()` saves both the user and assistant turns into
the ACTIVE thread's history (`saveOperatorThreadHistory` +
`touchActiveOperatorThread()`), not the old single-key
`saveOperatorChatHistory()`.

TEST: same file — asserts the exact call-site text and that
`saveOperatorChatHistory(state.operatorChatHistory);` no longer appears
inside `sendChatMessage`'s body.

AC-4 — `renderOperatorChat()`'s message bubble renders through the
existing `renderManualMarkdown()` instead of `bubble.textContent`, and
renders `msg.toolResults` (already present on the message object) as a
short activity line via a new `describeToolActivity()` helper.

TEST: same file — "renders bubbles through renderManualMarkdown…" and
"surfaces msg.toolResults…" assertions.

REAL-BROWSER VERIFICATION + MANDATORY VISUAL VERIFICATION (CLAUDE.md
Part 1 rule 26): screenshotted the real, unmodified `renderOperatorChat()`
output at 1400×900 and 390×844 with a seeded reply containing
`**bold**`/a bullet list and a `toolResults` entry — bold renders as
actual bold text (not literal asterisks), the ✅ emoji and the bullet list
render correctly, and the tool-activity line
("Created a task (VTID-09999)") appears in italic under the bubble at
both widths, with no horizontal overflow on mobile. Screenshots sent to
the user directly (`vtid03822-chat-desktop.png`,
`vtid03822-chat-mobile.png`, `vtid03822-chat-after-new-thread.png`).

**Deviation from the CLAUDE.md's literal screenshot recipe, disclosed
rather than silently substituted:** the documented recipe navigates a live
deployed URL (`vitanaland.com`) with a real Supabase auth session. This
session has no live gateway/Supabase credentials to do that against the
Command Hub specifically (it requires a real dev-user login, not the
community-app auth flow the recipe's own code sample targets). Instead:
served the actual `services/gateway/src/frontend/command-hub/` directory
tree at the same relative path the real gateway uses
(`/command-hub/app.js` etc.), loaded it in real headless Chromium, and
invoked the real, unmodified `renderOperatorChat()`/`initOperatorChatSession()`/
`startNewOperatorThread()`/`switchOperatorThread()` functions directly
(mounted outside `#root` so the app's own auth-gate re-render loop — there
is no live backend to authenticate against — doesn't clobber the test
harness). This exercises the real code and real DOM/CSS in a real
browser, including a real click interaction, which is strictly more than
a static screenshot would show; it does not exercise the real
`/api/v1/operator/chat` network call itself (which needs live backend
credentials this session doesn't have).

AC-5 — The identical markdown-rendering fix applied to
`renderCommandHubLiveConsoleView()`'s message content span, since it hits
the same `/api/v1/operator/chat` reply shape. The two chat surfaces
(Operator Console vs. Live Console) are deliberately NOT consolidated into
one component in this VTID — documented inline rather than silently left
inconsistent.

TEST: same file — "Live Console markdown rendering parity" block.

AC-6 — New CSS (`.chat-thread-bar`, `.chat-thread-select`,
`.chat-new-thread-btn`, `.chat-tool-activity`, `.chat-tool-activity-line`)
follows the existing dark-theme conventions in `styles.css`.

TEST: same file — "CSS additions" block.

AC-7 — `command-hub-ownership-guard.js`'s `ALLOWED_VTID_PATTERN` gets a
VTID-03822 entry (app.js + styles.css touched).

VERIFIED: `node --check scripts/ci/command-hub-ownership-guard.js` clean;
entry added with a descriptive comment following the exact precedent of
every prior entry in that file.

AC-8 — `tsc --noEmit` clean; no regression in the full gateway suite.

TEST: `outputs/tsc-noemit.txt`; `outputs/jest-vtid-03822-filter.txt` (1/1
suite, 13/13 tests); `outputs/jest-full-suite-tail.txt` (752/753 suites —
1 pre-existing skip — 13,796/13,831 tests passing, 0 failures).

## Deliberately NOT attempted

- **No backend conversation table.** Per the spec's own text, threading
  is entirely client-side. Continuity with the backend is unchanged —
  each thread has its own `conversationId`, sent exactly as
  `operatorConversationId` always was.
- **No consolidation of the Operator Console and Live Console chat
  surfaces** into one shared component — a materially larger UI
  refactor than this ticket's scope. Flagged explicitly (AC-5) rather
  than silently left as a drift point.
- **No live `/api/v1/operator/chat` network call was exercised** — this
  session has no live gateway/Supabase credentials. The request-building
  code (`sendChatMessage`) is unchanged except for which storage helper
  persists the response; the two save-call-site edits are covered by the
  source-text tests and by direct reading of the diff.
- **Thread deletion/rename UI** was not part of this VTID's spec (only
  "real, named, resumable threads") and was not added.
