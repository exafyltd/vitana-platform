---
lane: rehearsal
state: ready
next_actor: kiro
depends_on: [gitlab-client, fleet, settings, merge-bot]
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - scripts/eng/rehearse.mjs
  - scripts/eng/rehearse.test.mjs
  - infra/gitlab-engineering/rehearsal/**
  - docs/validation/**
updated: 2026-11-04T19:35Z
vtid: VTID-05540
---
# Lane: rehearsal (repo vitana-platform)
Tasks in `tasks.md`. Implements plan §3.8. The owner's run of it is acceptance A1 to A4. VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-03T19:40Z · kiro-exafy-202611021438-cff7 · ready
Lane created with the plan.

### 2026-11-04T19:35Z · ci-plan-spar · ready (VTID allocated)
VTID-05540 allocated after policy approval (converged-auto-v1).
