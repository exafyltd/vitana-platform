---
lane: migration-records
state: ready
next_actor: kiro
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
depends_on: []
paths:
  - docs/multitenancy/MIGRATION-QUEUE.md
  - scripts/ci/migration-drift-baseline.json
  - docs/validation/**
updated: 2026-11-02T16:06Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05479
---
# migration-records — MIGRATION-QUEUE rows + drift baseline for the four mt-identity-r2 DB slices
Added by Amendment 1: both files are hot and outside the DB lanes' paths. Merges before any DB lane. No migration,
no apply. VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-02T14:00Z · kiro-hotmail-202611011452-6d16 · created
Created through `_plan` (Amendment 1).

### 2026-11-02T16:06Z · ci-plan-spar · ready (VTID allocated)
VTID-05479 allocated after policy approval (converged-auto-v1).
