---
lane: console-probes-b
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
  - docs/validation/VTID-05003/staging-tests.json
  - docs/validation/VTID-05004/staging-tests.json
  - docs/validation/VTID-05064/staging-tests.json
  - docs/validation/VTID-05069/staging-tests.json
  - docs/validation/VTID-05071/staging-tests.json
  - docs/validation/VTID-*/**
updated: 2026-11-07T14:40Z
---
# Lane: console-probes-b (repo vitana-platform)
Repoint the Operator Console probes of VTID-05003, 05004, 05064, 05069 and 05071 from `app.js` to `operator-console.js`, keeping every string.
Plan: `.kiro/specs/staging-verify-manifest-repair/plan.md` §3 and the `<!-- lane: console-probes-b -->` section of `tasks.md` are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here. Deploys nothing; done when the lane PR is merged with green checks and its closing records are merged. Not a protected gate file.

## Log
### 2026-11-07T14:40Z · kiro-hotmail-202611061752-cc1f · created → ready
Lane created with the plan.
