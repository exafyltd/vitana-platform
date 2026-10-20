---
lane: reviewer-agent
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafy
area: platform
reviewer_seat: exafyltd
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - .kiro/agents/vitana-lane-reviewer.md
  - scripts/ci/kiro-steering/guard.cjs
  - scripts/ci/kiro-steering/guard.test.cjs
  - .kiro/pipeline/README.md
  - .kiro/pipeline/common-rules.md
  - .kiro/pipeline/planning.md
  - .kiro/pipeline/lane-code.md
  - .kiro/pipeline/lane-review.md
  - .kiro/pipeline/lane-land.md
  - .kiro/workflows/vitana-pipeline.workflow.json
  - .kiro/hooks/vitana-pipeline-start.json
  - docs/validation/VTID-*/**
updated: 2026-10-20T17:49Z
vtid: VTID-05275
---
# reviewer-agent — reviewer agent + pipeline recipe (vitana-lane-reviewer on claude-sonnet-5.5, runbooks, IDE workflow, SessionStart hook)
Plan: `.kiro/specs/kiro-autonomy-fallback/plan.md` §4.1, §4.2 and §5 G, and the `reviewer-agent` section of `tasks.md`
are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here. Repo
vitana-platform (the guard's agent check runs only where `scripts/collab/queue.mjs` exists, so vitana-v1 stays green).
Deploys nothing. Not a governance path today. Protected gate file created: `.kiro/agents/vitana-lane-reviewer.md` (owner
instruction, plan §6) — the agent never accepts a change to itself; this lane's own acceptance is the reviewer-agent run
pinned to claude-sonnet-5.5 by the workflow step. The recipe names `.kiro/pipeline/driver.md` (lane `exceptions-seat`)
and `.kiro/steering/vitana-pipeline.md` (lane `steering-rules`) as text only. Review entry committed under the legacy
`reviewer_seat` exafyltd. Shared files: none.
## Log
### 2026-10-20T17:20Z · kiro-exafyltd-202610201618-c018 · created → ready
Owner instruction 2026-10-20: "no more approvals, you run it end to end" — §7b merge instruction for this plan's named
set, approvals from the reviewer agent on claude-sonnet-5.5 (this lane defines it), pipeline as default for every future
Kiro IDE and Kiro Web session; lands after `steering-rules`. Lane created with the plan. Next: PLAN-SPAR; once `vtid:` is
set, seat exafy claims it.

### 2026-10-20T17:49Z · ci-plan-spar · ready (VTID allocated)
VTID-05275 allocated after policy approval (converged-auto-v1).
