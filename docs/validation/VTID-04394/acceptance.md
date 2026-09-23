# VTID-04394 — Orchestrator v2 P4: progress ledger + stall detection in the agent loop

Plan: `docs/ORCHESTRATOR-REDESIGN-PLAN.md` §3.3 "Progress ledger / stall detection", §5 P4 exit criterion: "a looping run stops with a `stalled` reason".

## Acceptance criteria

AC-1 A turn counts as progress when it edits a file, passes a check, or makes a tool call not made before in the run. Exact repeats (same tool, same arguments in any key order) and failed calls are not progress.
TEST: services/gateway/test/vtid-04394-progress-ledger.test.ts

AC-2 After `replanAfter` consecutive idle turns (default 6), the loop gets exactly ONE re-plan prompt. At `stopAfter` (default 10) the run ends with `stalled: true` and the error `agent stalled: N turns without progress`.
TEST: services/gateway/test/vtid-04394-progress-ledger.test.ts

AC-3 Exploration never stalls. Reading a new file or a new line range every turn keeps progressing, and only the turn cap ends such a run.
TEST: services/gateway/test/vtid-04394-progress-ledger.test.ts

AC-4 Progress after the re-plan resets the idle count. `stall: false` turns detection off. The existing loop contract (nudges, wrap-up, turn cap, cancel) is unchanged.
TEST: services/gateway/test/autopilot-agent-loop.test.ts

AC-5 A stalled run trips the VTID-04243 retry breaker exactly like a turn-cap exit, so a finding the agent looped on is not auto-reapproved.
TEST: services/gateway/test/vtid-04394-progress-ledger.test.ts

## Not verified live

Dev Autopilot is kill-switched (owner decision 2026-09-23, both LLM providers refusing) and staging cannot place ECS tasks. The first real signal will be an executor step `stalled: N turns without progress` on a run that previously would have burned its whole turn budget.
