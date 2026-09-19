# VTID-04110 — Acceptance

Reported live, hostile, with a screenshot of a long agentic Operator
Console turn: "you said you fixed the screen flickering with every new
turn. you also said you fixed that every turn is hidden behind a dropdown
instead of filling the screen unwanted. so where the fuck is the fixing
you made????"

The earlier claim of a fix came from the Operator Console's own
DeepSeek-powered agent, answering inside that same chat — a different
agent from the one that investigated and fixed this. Verified the live
code directly rather than taking either party's word for it; both
complaints were real, distinct, unfixed defects.

## Root cause

**Defect 1 — flicker on every new turn.** `applyOperatorTurnFrame()`
(VTID-04028's SSE turn-streaming handler) called the full-app `renderApp()`
— a root DOM teardown/rebuild of the entire Command Hub, sidebar, header,
and overlay included — on every streamed frame: one `tool.call` + one
`tool.result` per tool invocation, plus one `model.turn` per model call. A
multi-step agent run (the reported screenshot shows a dozen-plus turns,
several tool calls each) fires dozens of these per run, each one visibly
repainting the whole modal.

**Defect 2 — the console never fills the screen.** `state.isOperatorFullscreen`
(VTID-03905's fullscreen toggle) defaulted to `false` and was never
persisted, so every fresh page load reopened the console as a small,
fixed-size centered popup — exactly the "hidden behind a dropdown instead
of filling the screen" the user described — requiring a manual expand
click every single session before a long, still-growing turn transcript
could be read without scrolling inside a cramped box.

## Fix

**Defect 1:** new `updateOperatorLiveTranscriptDom()` — mutates only the
one DOM node that actually changed (`.chat-tool-activity--live`), matching
the incremental-update pattern this file already uses elsewhere for
high-frequency updates (VTID-01151's `updateApprovalsBadge()`). Falls back
to a real `renderApp()` only when that node isn't mounted yet (the first
frame of a turn). `applyOperatorTurnFrame()`'s three frame branches
(`tool.call`, `tool.result`, `model.turn`) all route through it instead of
calling `renderApp()` directly.

**Defect 2:** `state.isOperatorFullscreen` is now read from
`localStorage.getItem('vitana.operatorFullscreen')` at state init (failing
closed to the old `false` default if localStorage throws), and the
fullscreen toggle button writes the choice back with
`localStorage.setItem('vitana.operatorFullscreen', ...)` before
re-rendering — the same `vitana.<key>` convention every other persisted UI
preference in this file already uses.

## Acceptance criteria

AC-1: `applyOperatorTurnFrame()` no longer calls the full-app `renderApp()`
directly on any of its three frame branches.
TEST: `services/gateway/test/vtid-04110-operator-console-flicker-fullscreen-persist.test.ts`
— "applyOperatorTurnFrame() no longer calls the full-app renderApp() per
frame".

AC-2: all three frame branches route through the new incremental updater.
TEST: same file — same test, asserts exactly 3
`updateOperatorLiveTranscriptDom();` call sites.

AC-3: `updateOperatorLiveTranscriptDom()` mutates the live-transcript node
in place (`document.querySelector('.chat-tool-activity--live')` +
`existing.replaceWith(renderOperatorLiveTranscript())`) instead of
rebuilding the whole app.
TEST: same file — "updateOperatorLiveTranscriptDom() mutates the
live-transcript node in place instead of rebuilding the app".

AC-4: it falls back to a real `renderApp()` only when the live-transcript
node isn't mounted yet (the first frame of a turn), and that fallback
happens before the replace-path, never after.
TEST: same file — "falls back to a real renderApp() only when the
live-transcript node is not mounted yet".

AC-5: the incremental update keeps the chat pinned to the bottom while
streaming, respecting the user's own scroll position (VTID-04106's
`chatStickToBottom` flag) instead of dropping that behavior.
TEST: same file — "keeps the chat pinned to the bottom while streaming,
respecting the user's own scroll position (VTID-04106)".

AC-6: `state.isOperatorFullscreen` is read from localStorage at state
init instead of hardcoded `false`, and fails closed to `false` if
localStorage throws.
TEST: same file — "isOperatorFullscreen is read from localStorage at
state init instead of hardcoded false".

AC-7: the fullscreen toggle button writes the choice back to localStorage
before the re-render that makes it visible.
TEST: same file — "the fullscreen toggle button writes the choice back to
localStorage".

AC-8: the localStorage write is wrapped in try/catch, matching every other
localStorage write in this file.
TEST: same file — "the write is wrapped in try/catch, same fail-safe
convention as every other localStorage write in this file".

AC-9: cache-bust bumped together for `app.js`/`styles.css`, and the
Command Hub ownership guard allowlists VTID-04110.
TEST: same file — "ships the cache-bust for both app.js and styles.css
together, and the ownership-guard allowlist".

## Verification

`node --check` clean on `app.js`. `tsc --noEmit` clean across the gateway
service. Targeted suites: 2/2 suites, 25/25 tests passing (the new suite,
plus the pre-existing `vtid-04028-operator-turn-stream.test.ts`, whose own
stale assertion — "the live-transcript frame handler calls `renderApp()`
at least twice" — was removed and replaced with a dedicated
no-`renderApp()` test, since that old assertion literally encoded the
flicker defect as expected behavior).

Wider regression sweep (Command Hub `app.js` consumers that share state
init / cache-bust / the ownership guard): `test/scripts/command-hub-ownership-guard.test.ts`,
`test/vtid-04106-operator-chat-stick-to-bottom.test.ts`,
`test/vtid-04031-operator-turn-cost.test.ts`,
`test/vtid-04033-operator-execution-follow.test.ts`,
`test/vtid-03949-operator-sessions-sidebar-rename.test.ts`,
`test/vtid-03822-operator-chat-threads.test.ts` — 6/6 suites, 71/71 tests
passing, 0 regressions.

Mutation-verified: `git stash push --include-untracked` on the three
source files only (`app.js`, `index.html`,
`scripts/ci/command-hub-ownership-guard.js`), re-ran the new + amended
suites — 9 of 25 tests failed against the reverted (pre-fix) source, with
the flicker test failing on the exact literal `renderApp();` calls the fix
removes — then `git stash pop` restored the fix and a full re-run came
back 25/25 green again.

## Not done here

- Not yet re-verified against a live staging session — the next real
  signal is a long, multi-tool-call agentic turn in the Operator Console
  not visibly repainting the sidebar/header between steps, and the console
  reopening full-screen after the toggle was used and the page reloaded.
- No Playwright screenshot pass. This is a re-render-scope and
  persistence-timing fix to existing, already-visually-verified markup
  (`renderOperatorLiveTranscript()`'s own DOM, the overlay's existing
  `operator-overlay--fullscreen` class) — no markup or CSS changed, and
  the rendered output is pixel-identical in both the old and new code
  paths; a screenshot cannot show a difference in *how much* got
  rebuilt or *whether a choice survived a reload*, only that it looks the
  same either way. The Command Hub also requires an authenticated
  exafy_admin session against a live gateway, which this session doesn't
  have standing access to exercise interactively.
