# VTID-04016 — Agent executor hardening from Test Run #4b: repeated-check guard, agent-aware commands.log

Context: Test Run #4b (VTID-04012, execution `4f7d5ea4`, staging) opened PR #3382 in 9 min 07 s, but the transcript shows the model re-running an identically failing `run_check tsc` nine times with no file edit between runs — about 18 of its 22 minutes. Run #4 (`47a4d6eb`) did the same at turns 12, 13, 17, 24, 31, 33, 36, 38, 39, 44. A failing check cannot change outcome until the tree changes; re-running it is pure cost (and, on the executor task, ~1–2 min each).

Second observation from the same run: the VTID-04002 PR contract's `commands.log` was written for the single-shot executor ("fetch current content of N plan files", "parse <<<PR_TITLE>>> blocks") and is wrong for a PR the agent produced.

AC-1 — `run_check` refuses a `(kind, target)` check that has already failed `MAX_FAILED_ATTEMPTS_WITHOUT_EDIT` (2) times since the last file mutation, before anything runs, with a tool error telling the model to edit first. One retry is still allowed (a killed or timed-out process is a real flake).
TEST: services/gateway/test/vtid-04016-agent-check-guard.test.ts

AC-2 — `write_file`, `edit_file` and `delete_file` reset the guard for every key; passing checks never count; `git_diff`/`git_status` are never guarded; a tool context without a guard behaves exactly as before.
TEST: services/gateway/test/vtid-04016-agent-check-guard.test.ts

AC-3 — `buildCommandsLog` with `executor: 'agent'` describes the agent path (clone, tool loop, the guard, the runner's tsc with `--preserveSymlinks` under the VTID-04009 heap, paired jest, fix rounds, push) and records turns / fix rounds / refused checks / fallback; the default wording is byte-for-byte unchanged.
TEST: services/gateway/test/vtid-04016-agent-check-guard.test.ts

AC-4 — `runAgentExecutionSession` creates one guard per execution, passes it in the tool context, and passes `executor: 'agent'` + the stats to `applyPrContract`.
TEST: services/gateway/test/vtid-04016-agent-check-guard.test.ts (pure wiring is read-verified in the diff; the next Test Run on staging is the live exercise)

Not verified here: a real agent execution on the rebuilt executor image — the refusal message reaching a live model, and `checks_refused_by_guard` showing a non-zero count on a run that would previously have looped.
