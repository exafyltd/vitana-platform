# VTID-04212 — repeated-navigation guard for the agent executor

## Report

Root cause investigation, requested standing (per CLAUDE.md's "whenever the Operator Console
execution fails, check why and fix the fail"), into a batch of 30 Operator on-ramp executions
queued 2026-09-20 (VTID-04133..04162). 12 of the 14 spot-checked VTIDs (04149-04162, one-line
Command Hub CSS/JS/a11y tasks) all terminalized `failed` with the identical reason:
`agent hit the 120-turn cap without calling finish` (`self-healing.execution.failed` in
`oasis_events`).

Traced live via `oasis_events` (`dev_autopilot.agent.llm`/`.tool` steps for VTID-04149,
execution `7b73cd74`): the model called `read_file services/gateway/src/frontend/command-hub/styles.css`
with byte-identical arguments at turns 2, 10, 12, 16 and 17, and issued several near-duplicate
`search_text` calls against the same file, without ever converging on a `finish` call — for a
task whose whole diff should have been a few lines. Since nothing was edited between these
repeats, each one was guaranteed to return an identical result: pure wasted turns, the same
shape of defect VTID-04016 already fixed for `run_check` (Run #4b re-ran an identically failing
`tsc` nine times).

## Fix

`agent-check-guard.ts`'s `RepeatedCheckGuard` gains `shouldRefuseNav(tool, args)` /
`navRefusedCount()`: `read_file`/`search_text`/`list_dir`/`find_files` are refused on an EXACT
repeat (same tool + same JSON-stable-sorted arguments) since the last file mutation
(`write_file`/`edit_file`/`delete_file`, which already calls `markEdited()`), telling the model
to act on the content it already retrieved or change its arguments. `write_file`/`edit_file`/
`delete_file`/`finish`/`run_check` are unaffected — only the four pure-navigation tools are
guarded, and only exact-duplicate calls are refused; a different path, pattern, or line range is
never blocked. `executeAgentTool` (`agent-tools.ts`) checks the guard before dispatching any of
the four tools. `run-agent-execution.ts` passes `navRepeatsRefused: checkGuard.navRefusedCount()`
into the PR contract's `agentStats`, and `dev-autopilot-pr-contract.ts`'s `commands.log` now
records `nav_repeats_refused_by_guard=N` alongside the existing `checks_refused_by_guard`.

## Acceptance Criteria

AC-1 — `RepeatedCheckGuard.shouldRefuseNav` allows the first call with a given (tool, args) key,
refuses the next exact repeat, and `markEdited()` (already called by every file mutation) resets
it; a passing/failing outcome is irrelevant (unlike `shouldRefuse`, a nav call needs no separate
record step — same args + no tree change ⇒ identical output).
TEST: `services/gateway/test/vtid-04016-agent-check-guard.test.ts` — "VTID-04163 repeated-navigation
guard (pure)" (`npx jest test/vtid-04016-agent-check-guard.test.ts`).

AC-2 — Different arguments (including the same keys in a different JSON order) are treated as
distinct calls, never refused; tools outside the guarded set (e.g. `write_file`) are never
refused regardless of repetition.
TEST: `services/gateway/test/vtid-04016-agent-check-guard.test.ts` — "different arguments (or key
order) are distinct calls; unguarded tools are never refused".

AC-3 — `executeAgentTool` refuses an exact-repeat `read_file`/`search_text`/`list_dir`/`find_files`
call before doing any work, and an intervening `edit_file` re-enables it.
TEST: `services/gateway/test/vtid-04016-agent-check-guard.test.ts` — "VTID-04163: an exact-repeat
read_file is refused; a different range is not; an edit resets it" and "VTID-04163:
search_text/list_dir/find_files are guarded too; write_file/finish are never guarded".

AC-4 — `nav_repeats_refused_by_guard` is threaded through `run-agent-execution.ts` into
`dev-autopilot-pr-contract.ts`'s `commands.log`, alongside the pre-existing
`checks_refused_by_guard`, and the single-shot executor's wording is unchanged.
TEST: `services/gateway/test/vtid-04016-agent-check-guard.test.ts` — "agent executor: clone, tool
loop, guard, runner tsc + jest, fix rounds, push" and "default (single-shot) wording is
unchanged".

## Not verified

No live re-run against a real Operator on-ramp execution — the executor image would need
rebuilding from this commit and a new batch dispatched to confirm the 120-turn cap failure rate
actually drops on tasks of this shape. The fix is verified structurally (unit tests against the
real, unmocked guard/tool-dispatch code) and by reading the exact repeated-call pattern out of
the live `oasis_events` trace that caused this VTID, not by observing a fixed run in production.
