# VTID-04466 — Agent executor: starting map from the code index + exploration budget

Live evidence (2026-09-10 → 09-24, `dev_autopilot_executions` + `dev_autopilot.agent.*` events): 68 agent runs died on the turn cap and 49 of them never edited a file. Together they made 3,636 `search_text` and 2,853 `read_file` calls (~95 navigation calls per run) while the code index, loaded on every run since VTID-04229, was queried 11 times. In the same window, six of ~40 successful runs made their FIRST edit between turns 64 and 91, so the budget below is deliberately late.

## Acceptance criteria

AC-1 Thresholds are 35% (commit nudge), 80% (hand-off), 90% (stop) of `maxTurns`: 42/96/108 for the runner's 120-turn cap. Loops shorter than 30 turns (fix rounds) get no budget. The stop always leaves the last turn free and comes after the hand-off.
TEST: services/gateway/test/vtid-04466-exploration-budget.test.ts

AC-2 A run that has not edited anything gets the commit nudge and the hand-off instruction once each. It then stops with `explorationExhausted: true` and the error `agent explored N turns without editing any file (exploration budget)`. That error trips the VTID-04243 retry breaker like a turn-cap exit.
TEST: services/gateway/test/vtid-04466-exploration-budget.test.ts

AC-3 A run that edits before the stop point is never stopped by the budget. Without the option, the loop behaves exactly as before (turn cap). The stall ledger's re-plan keeps priority on the same turn, and the pending nudge is delivered on the next turn instead of being lost.
TEST: services/gateway/test/vtid-04466-exploration-budget.test.ts

AC-4 A hand-off finish with no edits ends the loop `ok` and carries the findings. The runner refuses the empty diff as before, and the failure reason now includes the agent's findings, so the operator sees them.
TEST: services/gateway/test/vtid-04466-exploration-budget.test.ts

AC-5 Before turn 1, the starting map is the index answer for the task text and the referenced files. It is an empty string when there is no index or nothing matched, and the prompt is then unchanged.
TEST: services/gateway/test/vtid-04466-exploration-budget.test.ts

AC-6 The runner adds the starting map on non-fix runs only. It applies the budget on round 0 of a non-fix run only. `AGENT_EXPLORATION_BUDGET_ENABLED=false` is the kill switch.
TEST: services/gateway/test/vtid-04466-exploration-budget.test.ts

## Not verified live

The first real signal is a staging agent run whose step feed shows `runner:starting_map`, followed by either an edit before turn 42 or an `exploration hand-off` step. The executor image has to be rebuilt from the merge commit first.
