---
lane: locale-zh-gap
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafy
area: platform
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - docs/validation/VTID-*/**
updated: 2026-11-07T14:43Z
vtid: VTID-05603
---
# Lane: locale-zh-gap (repo vitana-platform)
Investigate the staging `locale-coverage` degraded state read-only (zh 259/260) and hand the owner one decision; the VTID-04880 probe is not edited.
Plan: `.kiro/specs/staging-verify-manifest-repair/plan.md` §3 and the `<!-- lane: locale-zh-gap -->` section of `tasks.md` are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here. Deploys nothing; done when the lane PR is merged with green checks and its closing records are merged. Not a protected gate file.

## Log
### 2026-11-07T14:40Z · kiro-hotmail-202611061752-cc1f · created → ready
Lane created with the plan.

### 2026-11-07T14:43Z · ci-plan-spar · ready (VTID allocated)
VTID-05603 allocated after policy approval (converged-auto-v1).
