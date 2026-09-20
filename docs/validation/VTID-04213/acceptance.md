# VTID-04213 — Acceptance

`services/gateway/src/services/autopilot-agent/agent-loop.ts` gains a
second turn-budget nudge, `buildExplorationBudgetPrompt`, alongside the
existing `buildWrapUpPrompt` (VTID-04194) — for the opposite failure
shape: a run that never lands ANY edit at all, rather than one that
lands an edit too close to the cap.

## Investigation

Queried `dev_autopilot_executions`/`oasis_events`/`vtid_ledger` (read-only,
production Supabase) for the 30-task Command Hub operator-console batch
queued earlier this session. 11 VTIDs (VTID-04160/61/62/63/66/67/68/69/
70/71/77) terminalized `failed` with the identical
`agent hit the 120-turn cap without calling finish` error. All 4 sampled
in detail were **claimed after 21:07:12 UTC** — after VTID-04194's own
executor-image rebuild (`AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` run 16,
head_sha `f7d761b`, completed 21:07:12) — so this is a genuinely distinct,
still-live defect, not a stale-image artifact.

Per-VTID tool-call counts from `oasis_events` (`dev_autopilot.agent.tool.*`)
show the real shape: every one of the 11 spent 100-130+ turns almost
entirely on `read_file`/`search_text`/`find_files`, and **9 of the 10
sampled made ZERO `write_file`/`edit_file`/`delete_file` calls in the
whole run** (the 10th, VTID-04161, made 3 `edit_file` calls but still
failed — a separate, already-covered case: `hasEdited` was true but the
edit landed late enough that VTID-04194's own margin either didn't fire
in time or the checks/finish afterward still didn't fit). VTID-04194's
`buildWrapUpPrompt` cannot help the 9-of-10 case: its trigger (`hasEdited`)
is never true, so those runs kept receiving the open-ended
`CONTINUE_PROMPT` for their entire budget.

## Fix

`buildExplorationBudgetPrompt(turnsUsed, turnsRemaining)` — once
`explorationBudgetTurns` (default 40) turns have elapsed with no
successful mutating tool call yet, the continuation prompt switches from
`CONTINUE_PROMPT` to this one: stop broadening the search, make the best
edit available now, or — if the location genuinely cannot be found —
call `finish` explaining what could not be resolved, instead of silently
exhausting the turn cap. Wired into `runAgentLoop`'s existing
`if (hasEdited && …) … else … CONTINUE_PROMPT` branch as a third arm,
mirroring `buildWrapUpPrompt`'s own shape and using the same
`MUTATING_TOOLS`/`hasEdited` state VTID-04194 already tracks — no new
state, no new tool, no route/schema/flag change.

## Acceptance criteria

AC-1: once `explorationBudgetTurns` turns have elapsed with no
successful edit, the continuation prompt switches from `CONTINUE_PROMPT`
to `buildExplorationBudgetPrompt(turns, turnsRemaining)`.
TEST: `services/gateway/test/autopilot-agent-loop.test.ts` —
"switches to the exploration-budget prompt once turns used reach the
budget with no edit yet".

AC-2: the exploration-budget nudge never fires once a real edit has
landed — the pre-existing wrap-up path (VTID-04194) takes over instead,
regardless of how small the exploration budget is configured.
TEST: `services/gateway/test/autopilot-agent-loop.test.ts` — "never
fires once an edit has landed — the wrap-up path takes over instead".

AC-3: a FAILED `edit_file`/`write_file`/`delete_file` call does not
count as "an edit has happened" for exploration-budget purposes, same
invariant VTID-04194 already holds for the wrap-up path.
TEST: `services/gateway/test/autopilot-agent-loop.test.ts` — "does not
count a FAILED edit_file call as \"an edit has happened\" for
exploration-budget purposes".

AC-4: `explorationBudgetTurns` is a real, independently-read option, not
just the default.
TEST: `services/gateway/test/autopilot-agent-loop.test.ts` — "honors a
custom explorationBudgetTurns instead of the default 40".

AC-5: the regression shape from the live failure — many unproductive
read/search turns and no edit — now converges instead of silently
exhausting the cap.
TEST: `services/gateway/test/autopilot-agent-loop.test.ts` —
"regression: the 10-failed-execution shape — pure exploration with no
edit now converges instead of hitting the turn cap silently".

## Verification

`tsc --noEmit` (services/gateway) — clean.

Own suite: `services/gateway/test/autopilot-agent-loop.test.ts` — 25/25
passing (19 pre-existing + 6 new).

Regression sweep — every file that calls `runAgentLoop`:
`test/autopilot-agent-loop.test.ts`,
`test/vtid-04032-cancel-running-execution.test.ts` — 2 suites, 41 tests,
0 failures.

## Not done here

- Does not change the default turn/deadline budget
  (`AGENT_MAX_TURNS`/`deadlineMs`), only what the model is told to do
  with the turns it has.
- Does not force an edit — a model still genuinely narrowing down a real
  ambiguity is not cut off mid-thought; the nudge only removes the
  standing invitation to keep exploring indefinitely once the budget is
  spent.
- Not re-run against a live Dev Autopilot execution — the executor image
  needs to be rebuilt from this commit (same
  `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` `workflow_dispatch` path
  VTID-04194 itself used) before any new dispatch benefits from this fix.
- The 30-task batch's already-terminalized `failed` VTIDs (04160/61/62/
  63/66/67/68/69/70/71/77) are not retried automatically by this PR — a
  fresh `autopilot_run_task` per VTID, after the image rebuild, is the
  next step.

OASIS_IMPACT: no — this is an in-process prompt-selection change inside
the agent loop; it emits no new event topic (the existing
`dev_autopilot.agent.*` step events already cover a `nudge` kind).
