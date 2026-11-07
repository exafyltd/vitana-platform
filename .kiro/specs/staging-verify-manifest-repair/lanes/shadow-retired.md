---
lane: shadow-retired
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
  - docs/validation/VTID-04784/staging-tests.json
  - docs/validation/VTID-05007/staging-tests.json
  - docs/validation/VTID-*/**
updated: 2026-11-07T14:40Z
---
# Lane: shadow-retired (repo vitana-platform)
Retire only the deleted recall-shadow jest path from VTID-04784 and VTID-05007, with the VTID-05556 evidence, and point 04784 at the surviving recall test.
Plan: `.kiro/specs/staging-verify-manifest-repair/plan.md` §3 and the `<!-- lane: shadow-retired -->` section of `tasks.md` are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here. Deploys nothing; done when the lane PR is merged with green checks and its closing records are merged. Not a protected gate file.

## Log
### 2026-11-07T14:40Z · kiro-hotmail-202611061752-cc1f · created → ready
Lane created with the plan.
