# Responses — round 2

Session `64363084-889a-4b1b-a227-b0edc72ee6f4`. Planner: Kiro, seat `exafy`, session `kiro-202610220829-5884`.
All three findings accepted; `plan.md` D3, D3a (new), D4 and §5/§7 updated; `tasks.md` slot-sizing S1-S4 aligned
(per-step gating, D3 terminal rule, D3a watch recipe and fixtures).

```json
[
  {
    "finding_id": "R2-F1",
    "disposition": "accepted",
    "rationale": "D4 now gates each planning/approval step individually instead of as one group: investigate, spec, plan-pr, spar-loop and merge-plan each sit in their own `parallel joinPolicy any` race whose `-skip` watch carries `gatedNodeId` = that step id. Skip rule per step: its id is in RUN/run.json `steps_done`, OR (for investigate/spec/plan-pr) `plan_pr` is non-null, OR RUN/slots.json exists. A plan resumed mid-planning (steps_done=[setup,investigate,spec], plan_pr=null, no slots.json) therefore skips investigate and spec and runs only plan-pr. New run-gate.test.mjs fixtures: that exact mid-planning state (asserts investigate/spec skip, plan-pr runs), steps_done containing plan-pr with plan_pr set (all three skip), and a fresh run (none skip). Each gated step keeps its id; watches cost no session and no step budget (§2.5), so per-step gating adds no step nodes.",
    "deferred_to": null
  },
  {
    "finding_id": "R2-F2",
    "disposition": "accepted",
    "rationale": "D3 no longer relies on `steps[<gatedNodeId>].status === 'failed'` alone. Each `-skip` watch config also carries `gatedStepIds` (the step ids inside the gated subtree, e.g. code-1, the slot-1 reviewer steps, land-1). Terminal (append one line to RUN/blockers.md, return terminal-state) when EITHER steps[gatedNodeId].status is failed/cancelled/aborted OR any id in gatedStepIds has status failed/cancelled/aborted and none of gatedStepIds is running. The suggestion to also treat `paused` as terminal is taken only as a pinned, tested non-terminal: a paused step is resumable by the engine (transient model error, agent restart, §2.8) and aborting it would throw away resumable lane work; a paused run is surfaced by restart-watchdog (D7, which slot-sizing now depends on). Field paths are pinned to the installed engine: the slot-sizing coder captures a real (redacted) workflow-state.json from a run with a failed step inside a repeat, records the observed path(s) in docs/validation/<VTID>/commands.log, and encodes them as inline fixtures in run-gate.test.mjs: failed-at-repeat, failed-inner-step-in-repeat, failed-inner-step-in-wrapper, paused, running, missing state. If the observed engine path differs from both forms, the reader follows the observed path and the test pins it.",
    "deferred_to": null
  },
  {
    "finding_id": "R2-F3",
    "disposition": "accepted",
    "rationale": "New D3a gives the watch recipe. Both `-skip` and `-go`: handler command, `node scripts/collab/run-gate.cjs`, pollIntervalSec 30, commandTimeoutSec 30, idleTimeoutSec 86400 (24 h, above a 40-iteration lane slot's observed wall time); if the installed engine schema caps idleTimeoutSec lower, the cap and the engine's on-timeout behaviour are recorded in commands.log and the value set to the cap. Return contract: `-skip` first poll skip -> terminal-state, run -> idle with cursor {decided:'run'}; later polls -> terminal-state only on the D3 failure rule, else idle. `-go` first poll run -> new-activity, skip -> idle (aborted by the race when -skip completes). guard.test.cjs asserts every gated race has exactly one -skip and one -go watch with this config (incl. gatedNodeId, gatedStepIds for lane slots, idleTimeoutSec >= 86400 or the recorded cap). run-gate.test.mjs adds the idle-then-detect-failure sequence: poll 1 run -> idle, poll 2 running -> idle, poll 3 paused -> idle, poll 4 inner step failed -> terminal-state plus one blockers.md line.",
    "deferred_to": null
  }
]
```
