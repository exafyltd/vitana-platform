---
slug: mt-queue-superseded-close
author: kiro
author_seat: hotmail
executor: claude
next_actor: kiro
state: drafted
updated: 2026-11-10T09:50Z
---
# Handoff — mt-queue-superseded-close
A plan may reach `done` when each parked lane records `superseded_by: <lane>` naming a lane of the plan that is done
(`scripts/collab/queue.mjs`, around line 390). Owner instruction: `docs/multitenancy/KIRO-HOTMAIL-DIRECTIVE-M0.md` on
`claude/youthful-cannon-vzsnio`, decision 3. Plan: `plan.md`.
Lane `superseded-close`: executor **claude** because `queue.mjs` is a protected gate file (the validator refuses
`executor: kiro` for it); built by Kiro seat `hotmail`, reviewer agent. The merge needs a reviewer-agent accept on the
current head and the owner directive named above.
## Log
### 2026-11-10T09:50Z · kiro-hotmail-202611061752-cc1f · created → drafted
Authored from the owner directive decision 3. Planner: Kiro seat `hotmail`, session kiro-hotmail-202611061752-cc1f,
holding `mt-queue-superseded-close/_plan`. No VTID; PLAN-SPAR spars this PR and allocates the lane VTID on convergence.
