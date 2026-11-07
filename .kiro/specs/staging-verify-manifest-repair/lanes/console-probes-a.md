---
lane: console-probes-a
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
  - docs/validation/VTID-04887/staging-tests.json
  - docs/validation/VTID-04975/staging-tests.json
  - docs/validation/VTID-04984/staging-tests.json
  - docs/validation/VTID-04999/staging-tests.json
  - docs/validation/VTID-*/**
updated: 2026-11-07T14:43Z
vtid: VTID-05600
---
# Lane: console-probes-a (repo vitana-platform)
Repoint the Operator Console probes of VTID-04887, 04975, 04984 and 04999 from `app.js` to `operator-console.js`, keeping every string.
Plan: `.kiro/specs/staging-verify-manifest-repair/plan.md` §3 and the `<!-- lane: console-probes-a -->` section of `tasks.md` are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here. Deploys nothing; done when the lane PR is merged with green checks and its closing records are merged. Not a protected gate file.

## Log
### 2026-11-07T14:40Z · kiro-hotmail-202611061752-cc1f · created → ready
Lane created with the plan.

### 2026-11-07T14:43Z · ci-plan-spar · ready (VTID allocated)
VTID-05600 allocated after policy approval (converged-auto-v1).
