---
lane: s-j-route-inventory
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-v1]
paths:
  - supabase/functions/linkedin-import/**
  - supabase/config.toml
  - src/lib/edge-functions-caller-identity.s4.test.ts
  - scripts/check-edge-function-auth.mjs
  - package.json
  - docs/validation/**
updated: 2026-11-01T16:59Z
vtid: VTID-05442
---
# Lane: s-j-route-inventory (repo vitana-v1)
Tasks in `tasks.md`. Remove the dead `linkedin-import` edge function and add the edge-function auth gate. VTID from
PLAN-SPAR; never by hand.

## Log
### 2026-11-01T15:00Z · kiro-hotmail-202611011402-f523 · ready
Lane created with the plan.

### 2026-11-01T16:59Z · ci-plan-spar · ready (VTID allocated)
VTID-05442 allocated after policy approval (converged-auto-v1).
