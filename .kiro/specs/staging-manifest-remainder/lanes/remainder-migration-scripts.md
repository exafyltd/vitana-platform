---
lane: remainder-migration-scripts
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
  - package.json
  - docs/validation/VTID-05506/staging-tests.json
  - docs/validation/VTID-05507/staging-tests.json
updated: 2026-11-12T11:55Z
vtid: VTID-05777
---
# Lane: remainder-migration-scripts (repo vitana-platform)
Give the migration drift suite a valid root script, and point VTID-05506 and VTID-05507 at it.
Plan: `.kiro/specs/staging-manifest-remainder/plan.md` §2.2 and `tasks.md` section `remainder-migration-scripts` are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.

## Log
### 2026-11-11T21:30Z · kiro-exafy · created → ready
Lane created with the plan.

### 2026-11-12T11:55Z · ci-plan-spar · ready (VTID allocated)
VTID-05777 allocated after policy approval (converged-auto-v1).
