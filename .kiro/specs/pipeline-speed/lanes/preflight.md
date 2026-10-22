---
lane: preflight
state: ready
next_actor: kiro
depends_on: []
executor: claude
seat: exafyltd
area: platform
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - scripts/collab/preflight.mjs
  - scripts/collab/preflight.test.mjs
  - .kiro/pipeline/lane-code.md
  - .kiro/pipeline/planning.md
  - .kiro/pipeline/driver.md
  - docs/validation/VTID-*/**
updated: 2026-10-22T20:46Z
vtid: VTID-05336
---
# preflight — every CI governance check of a lane or plan PR, locally, in one pass (item 2)
Plan: `.kiro/specs/pipeline-speed/plan.md` §2.6, D5, and the `preflight` section of `tasks.md` are authoritative.
VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here. Repo vitana-platform (the
command also checks a vitana-v1 checkout). Deploys nothing. `executor: claude` because `scripts/collab/**` is a
governance path; Kiro seat `exafy` builds it under kiro-autonomy-fallback. Spawns `queue.mjs`, `gate.mjs` and
`guard.cjs` without editing them. Protected gate files touched: none. Shared files: none.
## Log
### 2026-10-22T11:20Z · kiro-202610220829-5884 · created → ready
Lane created with the plan (owner: "yes, execute your recommendation", 2026-10-21). Next: PLAN-SPAR; once `vtid:` is
set, seat exafy claims it.

### 2026-10-22T17:50Z · ci-plan-spar · ready (VTID allocated)
VTID-05336 allocated after policy approval (converged-auto-v1).
### 2026-10-22T20:46Z · pm-agent · update
reassign lane exafy→exafyltd (stale_ready, Claude unavailable)
