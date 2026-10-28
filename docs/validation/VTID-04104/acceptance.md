# VTID-04104 — Acceptance

Reported live while testing the on-ramp Dev Autopilot execution VTID-04102
had just unblocked: "I changed the title of the task and now the process
stopped... or the process is not displayed anymore." Screenshot showed the
Operator Console's Chat tab with the assistant's final reply rendered as
plain static text — no chip, no pulsing status, no turn-by-turn dropdown —
looking exactly like a dead process.

## What was actually happening on the backend

Confirmed live via `oasis_events` and `dev_autopilot_executions` at the
moment of the report: execution `22cbc22f-1ccb-45e9-a00e-f86f48e4227e`
(VTID-04103) was `status: running`, on turn 86, with a `dev_autopilot.agent.*`
event 1 second old. `vtid_ledger.VTID-04103.updated_at` had not moved since
creation. The backend never stopped for a moment — this was purely a
client-side display defect.

## Root cause

`setTaskTitleOverride()` (the function behind both the Kanban card's inline
title edit and the task drawer's title edit) only writes to
`localStorage.vitana.taskTitleOverride.<vtid>` — it never calls the server
and cannot affect an execution. Renaming the title was not the direct
cause; it's a strong candidate for having driven the user off the Operator
Chat screen and back (to reach the title-edit UI), which is what actually
triggered the loss:

`switchOperatorThread()` and the page-load bootstrap
(`initOperatorChatSession()`) both rebuild `state.chatMessages` from the
**persisted** `state.operatorChatHistory` (`saveOperatorThreadHistory()` /
`getOperatorThreadHistory()`, `localStorage`). That persisted shape has
only ever been `{ role, content, ts }` — `followExecIds` (VTID-04033, the
array of execution ids a turn queued, which is what makes
`renderOperatorExecutionFollow()` attach the live panel) was set **only**
on the separate, in-memory-only `state.chatMessages` push inside
`sendChatMessage()`, never on the history entry that is actually written
to storage. So any thread switch, or a page reload landing back on the
same thread, silently and permanently dropped the live follow for a
still-running execution — the reply text survives (it's real content), the
live panel does not (it was never persisted in the first place).

## Fix

1. `sendChatMessage()`: compute `followExecIds` once into
   `turnFollowExecIds` and put it on **both** the in-memory
   `state.chatMessages` push and the `assistantHistoryEntry` that gets
   pushed to `state.operatorChatHistory` and persisted via
   `saveOperatorThreadHistory()`.
2. New shared helper `reattachFollowedExecutions(chatMessages)`: for every
   restored message with a non-empty `followExecIds`, calls
   `followOperatorExecution(execId)` again. The stream it opens
   (`GET /executions/:id/stream`, VTID-03897) replays an execution's full
   step history from the start on every fresh connect and emits `terminal`
   immediately if it already finished — so this is safe unconditionally: a
   still-running execution resumes its live ticker/turn dropdown, an
   already-finished one shows its final status instead of nothing.
3. `switchOperatorThread()`: carries `followExecIds` through the
   `history.map()` restore, closes the OLD thread's follows first
   (`closeAllOperatorExecutionFollows()` — previously only called from
   `startNewOperatorThread()`, so switching between two EXISTING threads
   never even cleaned up the old one's SSE connections), then calls
   `reattachFollowedExecutions(state.chatMessages)`.
4. `initOperatorChatSession()` (the page-load bootstrap): same — carries
   `followExecIds` through and reattaches on load, so a page reload landing
   on a thread with a live execution shows it live again instead of dead.

## Acceptance criteria

AC-1: the history entry that is actually persisted to `localStorage`
carries `followExecIds`, not just the in-memory chat bubble.
TEST: `services/gateway/test/vtid-04104-operator-follow-persist.test.ts` —
"sendChatMessage persists followExecIds onto the history entry that is
actually saved to storage".

AC-2: a shared helper exists that reopens the live SSE follow for every
restored execution id.
TEST: same file — "defines a shared reattachFollowedExecutions() helper
that reopens a live follow for every restored id".

AC-3: switching threads restores `followExecIds` and reattaches the
follow, after first closing the thread being left.
TEST: same file — "switchOperatorThread carries followExecIds through the
restore and reattaches them, after closing the OLD thread's follows".

AC-4: a page reload restores `followExecIds` and reattaches the follow the
same way.
TEST: same file — "initOperatorChatSession (the page-load bootstrap)
carries followExecIds through and reattaches them too".

AC-5: the pre-existing VTID-04033 suite still holds under the refactor
(computing `followExecIds` once into a shared `turnFollowExecIds` instead
of inline at two call sites).
TEST: `services/gateway/test/vtid-04033-operator-execution-follow.test.ts`
— "sendChatMessage stamps followExecIds on the reply and follows each
execution the turn queued" (updated to match the new, equivalent shape).

## Verification

`tsc --noEmit` clean. `node --check` clean on both edited `.js` files.
Targeted suites: 4/4 suites, 29/29 tests passing (the two above plus
`command-hub-ownership-guard.test.ts` and the still-standing
`vtid-04102-operator-truncated-reply.test.ts`).

Mutation-verified: reverted `app.js` only (`git stash`), re-ran the new
suite — 4 of 5 tests failed with the exact missing wiring (no
`followExecIds: msg.followExecIds` in either restore function, no
`reattachFollowedExecutions` reference), then restored (`git stash pop`)
and confirmed green again.

## Not done here

- Not re-verified against a live staging session yet — the next real
  signal is opening a still-running (or just-finished) execution's thread,
  switching away and back (or reloading the page), and confirming the
  live ticker/turn dropdown reappears instead of the reply sitting there
  static.
- No Playwright screenshot pass: this is a state-restoration/data-flow fix
  to an already-shipped, already-visually-verified panel
  (`renderOperatorExecutionFollow()`, VTID-04033) — no markup or CSS
  changed, only when the existing panel gets attached.
- Did not investigate the two flicker/collapsed-turns UX complaints raised
  in the same conversation (screen flicker on each turn; turns should be
  collapsed behind a dropdown, Claude-Code-CLI style) — those are a
  separate, still-open ask on the same panel and need their own VTID.
