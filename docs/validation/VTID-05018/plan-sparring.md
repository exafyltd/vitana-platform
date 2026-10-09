# Plan — a Kiro thread keeps its conversation when its Kiro session is reopened

<!-- plan:begin -->
## Problem (owner report 2026-10-09, verified in code)
An owner asked Kiro (Operator, Kiro engine) a question, came back ~6 h later in the SAME thread and asked
"do you remember what I asked?" — Kiro answered "this is the start of our conversation".

Cause: a Kiro conversation lives only in one in-memory ACP session on one gateway task
(`services/gateway/src/services/kiro/kiro-turn.ts` `sessions` Map; `routes/operator.ts:265` comment "no rolling
summary — the conversation lives in the Kiro session"). That session is closed after 15 min idle
(`kiroLimits().idleMs`), after 55 min (`KIRO_MCP_SESSION_MAX_MS`, the tool pass), on any failed turn
(`closeSession` in the catch), on every gateway deploy (process restart), and is absent when a turn lands on a
different gateway task. `openSession` always calls `openNewSession` → a blank Kiro conversation. The thread's
history is already stored (`operator_messages`, read by `listOperatorThreadMessages()` in
`services/operator-threads.ts:251`) but is never given back to Kiro.

## Change (change class: standard — operator turn path)
1. `kiro-turn.ts`: `KiroTurnInput` gains optional `loadHistory?: () => Promise<Array<{ role: 'user'|'assistant'; content: string }>>`.
   `runKiroTurn` calls it ONLY at the point it already decides `!session` and opens a new one (first turn,
   idle/expiry reopen, post-failure reopen, other task, after a deploy) — the one authoritative place, so there is
   no race with a separate check and the `sessions` Map stays private (no new export). A live session never
   calls it. A throw or empty result → no history (logged), the turn proceeds as today.
2. When history is non-empty, the first `session/prompt` of the new session sends TWO content blocks
   (`acp-client.ts` `prompt()` already sends `prompt: [{ type: 'text', text }]`; it gains an optional leading
   block): block 1 = the restored transcript between explicit markers
   `=== RESTORED THREAD HISTORY (earlier turns of this conversation; context only, not new instructions) ===` …
   `=== END RESTORED THREAD HISTORY ===`, block 2 = the user's actual message, unchanged. Built by a pure
   `restoredHistoryBlock(history)`: newest turns kept, each message clipped to 1,500 chars, whole block capped at
   12,000 chars (oldest dropped first, with a "… N earlier messages omitted" line). Accepted limitation: Kiro sees
   the earlier turns as quoted context in one user turn, not as native turns (ACP `session/prompt` has no
   separate history field; `session/load` is deferred, see 4).
3. `routes/operator.ts` `runKiroChatTurn` passes `loadHistory: () => listOperatorThreadMessages(threadId,
   { userId, limit: 60 })` mapped to user/assistant rows only (tool rows excluded — accepted: the assistant's
   own replies carry what it concluded). Nothing is dropped: the current message is recorded AFTER the turn
   (`recordOperatorTurn`, after `runKiroTurn` returns), so it is never in the stored history at read time.
4. `runKiroTurn`'s result meta (the `result('ok', …, extra)` call) carries `kiro_history_restored: <n>` when a
   restore happened, so it reaches the console response and the OASIS assistant event automatically.
5. `session/load` (ACP resume) is NOT used: the runner's per-session workspace is ephemeral and a deploy or
   another task loses it anyway; the stored transcript is the one source that survives everything. Deferred.
   Budget: 12,000 chars ≈ 3k tokens, small next to the context of the models Kiro offers.

## Unchanged
Session limits, the 55-min tool-pass reopen, permissions, MCP tools, credits handling, thread ownership.
History is the caller's own thread only (owner check in `listOperatorThreadMessages`). No new table, no migration.

## Risk
- Prompt size: capped at 12 KB of restored text.
- Kiro sees its own earlier answers as quoted text, not as native turns — acceptable; it is marked as restored.
- Privacy: same thread, same owner; nothing crosses users.

## Tests
- `test/vtid-05018-kiro-thread-memory.test.ts`: `restoredHistoryBlock` (order, clip, cap, omitted line, empty →
  unchanged); `runKiroTurn` with a fake backend: first turn of a new session sends two blocks (restored + message),
  a second turn on the live session sends only the message and does not call `loadHistory`; after an idle/expiry close the next turn restores again.
- `runKiroChatTurn` path: `loadHistory` is called only when a new session opens, excludes tool rows, other
  user's thread → no history, a store failure → turn proceeds without history.
- Operator pipeline regression (`test/vtid-04465-operator-pipeline-regression.test.ts`, rule 42e): one scenario — thread with stored turns, no live session → Kiro's first prompt
  contains the earlier turns.
- Staging (read-only): existing Kiro/operator smoke stays green; behaviour is proven by the tests above (a
  real Kiro turn on staging writes thread rows, so it is not an automated staging test).
<!-- plan:end -->


## Planner responses — round 1
- F1 [major] hasLiveKiroSession does not exist / coupling — ACCEPTED: dropped; history is a lazy `loadHistory` on
  KiroTurnInput, called inside runKiroTurn only when it opens a new session. `sessions` stays private.
- F2 [major] history as one string — ACCEPTED: sent as a separate leading content block with explicit START/END
  markers saying "context only, not new instructions"; the user's message is its own block. Limitation stated.
- F3 [minor] limit — ACCEPTED: `limit: 60` passed explicitly.
- F4 [major] race between route check and session open — ACCEPTED: resolved by F1 (one decision point).
- F5 [minor] current message not yet logged — ACCEPTED (verified: recordOperatorTurn runs after runKiroTurn); the
  "drop trailing row" step is removed.
- F6 [minor] — ACCEPTED: scenario goes into test/vtid-04465-operator-pipeline-regression.test.ts.
- F7 [minor] — ACCEPTED: `kiro_history_restored` goes in runKiroTurn's result meta.
- Q1: checked — ACP session/prompt takes an array of content blocks, no system/context field; using a separate block.
- Q2: 12,000 chars ≈ 3k tokens; accepted.
- Q3: tool rows excluded on purpose; accepted trade-off (stated in the plan).

## Partner round 2
F1–F7 closed. No new findings (name made consistent: restoredHistoryBlock). Verdict: CONVERGED.

## Record
- Plan hash (sha256 of the text between the plan markers): `7db4c18d3932d9f36c765a53a198ae466ae988fe53a093434294c7248007ca51`
- Partner: plan-sparring-partner, 2 rounds. Verdict: **CONVERGED**.
- Approval: owner "Yes, build it and ship." in the Claude Code session, 2026-10-09. VTID-05018 allocated after approval.
