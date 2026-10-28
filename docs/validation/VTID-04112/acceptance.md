# VTID-04112 — Acceptance

The platform owner reported, in conversation, that "every attempt to build
something with Operator failed" and asked whether this was known. Rather
than restate the one successful verification pass already on record
(VTID-04037), investigated the real failure rate directly against
`dev_autopilot_executions`/`dev_autopilot_outcomes`/`oasis_events` for the
Dev Autopilot agent executor — the tool loop behind `autopilot_run_task`/
`autopilot_execute_task` — over the prior 3 days.

## What was found

26 of 43 agent-executor runs in the window failed either by exhausting the
turn cap ("agent hit the N-turn cap without calling finish") or by hitting
the 3-strike nudge limit ("model answered with text N times in a row
without calling finish") — regardless of how large `AGENT_MAX_TURNS` was
raised across different executions (33 → 120 turns), which rules out "not
enough turns" as the actual cause. One execution (`5d301440-...`,
VTID-04109) was traced turn-by-turn via `oasis_events`: 81 turns, 6.87M
cumulative input tokens, $1.14 cost, and the failure was three consecutive
turns whose `dev_autopilot.agent.llm` step recorded `"text (0 chars)"` —
DeepSeek returning HTTP 200 with an empty `content` field and no
`tool_calls`.

## Root cause

`agent-loop.ts`'s `runAgentLoop()` resent the ENTIRE accumulated
`history` array to the model on every turn (`o.callLlm(prompt, [...history],
...)`), with no bound on cumulative size — only an individual tool
result was clipped (`TOOL_RESULT_MAX_CHARS`, 30,000 chars). DeepSeek's
visible answer (text or a tool call) shares its output-token budget
(`max_tokens`, `AGENT_MAX_TOKENS`, default 8000) with its own internal
reasoning tokens. As the resent context grows turn over turn, the model's
reasoning alone can eventually exhaust that shared budget before any
visible output is produced, and the API returns an empty completion —
which `runAgentLoop()` cannot distinguish from the model genuinely
choosing to answer with prose instead of a tool call. That silently
burns the 3-strike nudge counter (or, on a longer run, just wastes turns)
until the run dies with a misleading "model stopped using tools" error,
even though the model never made that choice — its response was
truncated by exhausted reasoning budget, not deliberate text output.

This explains both observed failure shapes (turn-cap exhaustion and
nudge-limit exhaustion) as the same underlying defect at different
points in a run, and explains why raising the turn cap never helped: a
longer cap only gives the context more turns to grow before the same
budget exhaustion recurs.

## Fix

`trimHistoryForBudget()` (new, pure, exported from `agent-loop.ts`) bounds
the character count of the history **resent to the model on each call**,
independent of the `history` array returned to and stored by the caller.
When the resent copy exceeds `historyCharBudget` (default 120,000 chars,
env-tunable via `AGENT_HISTORY_CHAR_BUDGET` in `run-agent-execution.ts`),
the OLDEST tool results are replaced with a short trim notice, one at a
time, until the budget is met or only the single most recent message
remains (which is never trimmed — the model needs its own last action
intact to continue coherently). The stored/returned `history` — which
`run-agent-execution.ts` threads across fix rounds and uses for the PR
evidence trail — is never mutated; only the copy passed to `o.callLlm` is
trimmed, and it is trimmed fresh on every call from the full history, so
early turns are not permanently lost from the transcript, just excluded
from later requests once they are no longer needed to continue the work.

## Acceptance criteria

AC-1: a history under the budget passes through `trimHistoryForBudget()`
completely unchanged (same reference, not just equal content).
TEST: `services/gateway/test/autopilot-agent-loop.test.ts` — "returns the
history unchanged when under budget".

AC-2: once over budget, the OLDEST tool results are replaced with the trim
notice, and the single most recent message in the array is never touched.
TEST: same file — "replaces the OLDEST tool results with a notice once
over budget, leaving the newest message intact"; also confirms the
original array passed in is not mutated.

AC-3: trimming proceeds forward through the history, oldest first, until
under budget or only the last message remains — even if the budget is
still technically exceeded once every trimmable entry is trimmed.
TEST: same file — "keeps trimming forward through the history until under
budget or only the last message remains".

AC-4: the default budget is 120,000 chars when no explicit budget is
passed.
TEST: same file — "defaults to the 120,000-char budget when none is
passed".

AC-5: `runAgentLoop()` sends the TRIMMED copy to `callLlm` once the
resent history exceeds budget, while the `history` returned to the
caller keeps every tool result in full, untrimmed.
TEST: same file — "sends a trimmed copy to callLlm while the returned
history keeps every result in full".

AC-6: a custom `historyCharBudget` option is honored instead of the
120,000-char default, forcing an earlier trim than the default would.
TEST: same file — "honors a custom historyCharBudget instead of the
120,000-char default".

AC-7: no trimming happens at all while the (default or custom) budget is
not exceeded — the exact tool result text is still resent verbatim.
TEST: same file — "never trims when the default 120,000-char budget is
not exceeded".

AC-8: `run-agent-execution.ts` wires `historyCharBudget` from a new
`AGENT_HISTORY_CHAR_BUDGET` env var (default 120000) into every
`runAgentLoop()` call across fix rounds.
TEST: verified by direct source read — `AGENT_HISTORY_CHAR_BUDGET` is
declared alongside `AGENT_MAX_FIX_ROUNDS` and passed as
`historyCharBudget` in the `runAgentLoop({...})` call inside the
fix-round loop. No dedicated unit test — this is a one-line, env-driven
wiring pass-through of AC-5/AC-6's already-tested `runAgentLoop` option,
consistent with how the file's other env-tunable constants (e.g.
`AGENT_MAX_TURNS`, `AGENT_DEADLINE_MS`) are wired without their own test.

## Verification

`tsc --noEmit` clean across the gateway service. New tests: 7 (added to
the pre-existing `test/autopilot-agent-loop.test.ts` suite, which now has
13 tests total, all passing, 0 regressions on the 6 pre-existing tests).
Wider regression sweep across the agent-executor area this touches:
`test/autopilot-agent-scope-validate.test.ts`,
`test/autopilot-agent-tools.test.ts`, `test/llm-router-agentic.test.ts`,
`test/vtid-04016-agent-check-guard.test.ts`,
`test/vtid-04046-agent-prompt-date.test.ts`,
`test/vtid-04032-cancel-running-execution.test.ts`,
`test/vtid-04029-dev-autopilot-pr-approval.test.ts` — 9 suites total (this
VTID's own suite included), 133 tests, all passing, 0 regressions.

## Not done here

- Not yet verified against a live staging agent-executor run — the next
  real signal is a long-running `autopilot_run_task`/`autopilot_execute_task`
  execution completing (or failing for a genuinely different reason)
  instead of dying with "model stopped using tools" or hitting the turn
  cap after the context has grown large.
- Does not address DeepSeek's `reasoning_content`/`finish_reason` fields
  going unread in `llm-router.ts`'s `deepseekAdapter` — reading
  `finish_reason:'length'` would give a stronger, more direct signal that
  a completion was truncated by budget rather than chosen by the model,
  and is a reasonable follow-up, but the history-bounding fix in this VTID
  addresses the root cause (the resent context growing unboundedly) at
  the loop level regardless of which exact DeepSeek internal mechanism
  produces the empty response, so it was not required for this fix.
- Does not change `TOOL_RESULT_MAX_CHARS` (still 30,000 chars per result)
  or `AGENT_MAX_TOKENS` (still 8000) — those bound different things
  (one result's size; the model's own per-call output budget) and were
  not implicated as the root cause.

OASIS_IMPACT: no — this is an internal loop-shape fix to the agent
executor's own tool-call resend logic; it emits no new OASIS events and
changes no existing event schema or topic.
