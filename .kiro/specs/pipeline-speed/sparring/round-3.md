# Sparring round 3 — converged

Session: `64363084-889a-4b1b-a227-b0edc72ee6f4` · plan hash `d5a26802840bf473293b3baf45100164ca1ee1d038b441c9f31af15e4110b1fe`

## Summary

All three R2 findings were accepted by the planner. The revised plan substantively addresses each one: D4 now gates each planning step individually using `steps_done` (R2-F1), D3's terminal rule covers multiple failure statuses plus `gatedStepIds` with pinned field paths (R2-F2), and D3a provides a concrete watch recipe with `idleTimeoutSec: 86400` and full return contract (R2-F3). I was unable to access the repository at the pinned commit this round (consistent 403 errors on every `read_file`/`list_dir` call), so I cannot verify new premises or raise new code-backed findings. The plan appears internally consistent and the revisions are coherent with the earlier findings. No new issues raised.

## Findings

_none_
## Acknowledgements of earlier responses

- R2-F1: acknowledged — Accepted and addressed. D4 now gates investigate, spec, plan-pr, spar-loop, and merge-plan each in its own parallel-any race, with skip conditions consulting steps_done per step id. The mid-planning resume fixture (steps_done=[setup,investigate,spec], plan_pr=null, no slots.json → investigate/spec skip, plan-pr runs) is specified. The plan's stated goal of zero wasted sessions on resumed plans is now mechanically enforced per step rather than relying on coarse plan_pr/slots.json booleans.
- R2-F2: acknowledged — Accepted and addressed. D3's terminal rule now covers steps[gatedNodeId].status ∈ {failed,cancelled,aborted} OR any gatedStepIds member in those statuses while none is running. paused is explicitly pinned as non-terminal. The coder is required to capture a real workflow-state.json from a failed-step-in-repeat run and pin field paths as inline test fixtures. The six specified fixture cases (failed-at-repeat, failed-inner-step-in-repeat, failed-inner-step-in-wrapper, paused, running, missing) cover the relevant engine states.
- R2-F3: acknowledged — Accepted and addressed. D3a specifies handler command, pollIntervalSec 30, commandTimeoutSec 30, idleTimeoutSec 86400 with a cap-recording fallback. The return contract is fully specified for both -skip and -go watches. guard.test.cjs is required to assert the recipe on every gated race. run-gate.test.mjs includes the idle-then-detect-failure sequence (4-poll scenario). The engine-cap recording in commands.log provides an audit trail if the 24h value is adjusted.
