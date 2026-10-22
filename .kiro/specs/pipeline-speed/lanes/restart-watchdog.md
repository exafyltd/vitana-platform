---
lane: restart-watchdog
state: ready
next_actor: kiro
depends_on: []
executor: claude
seat: exafy
area: platform
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - .kiro/hooks/vitana-workflow-watchdog.json
  - scripts/collab/workflow-watchdog.mjs
  - scripts/collab/workflow-watchdog.test.mjs
  - .kiro/pipeline/restart-watchdog.md
  - .kiro/pipeline/README.md
  - docs/validation/VTID-*/**
updated: 2026-10-22T17:50Z
vtid: VTID-05337
---
# restart-watchdog — workflow runs paused by an agent restart are surfaced at session start (item 4)
Plan: `.kiro/specs/pipeline-speed/plan.md` §2.8, D7, and the `restart-watchdog` section of `tasks.md` are
authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here. Repo
vitana-platform. Deploys nothing. `executor: claude` because `scripts/collab/**` is a governance path; Kiro seat
`exafy` builds it under kiro-autonomy-fallback. Read-only: the hook reports and instructs, it never writes engine
state. `.kiro/hooks/vitana-pipeline-start.json` stays unchanged. Protected gate files touched: none. Shared files: none.
## Log
### 2026-10-22T11:20Z · kiro-202610220829-5884 · created → ready
Lane created with the plan (owner: "yes, execute your recommendation", 2026-10-21). Next: PLAN-SPAR; once `vtid:` is
set, seat exafy claims it.

### 2026-10-22T17:50Z · ci-plan-spar · ready (VTID allocated)
VTID-05337 allocated after policy approval (converged-auto-v1).
