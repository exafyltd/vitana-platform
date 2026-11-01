---
lane: s-j-retire-allowlist
state: ready
next_actor: kiro
depends_on: [s-j-route-inventory]
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-v1]
paths:
  - .github/workflows/SUPABASE-FUNCTIONS-RETIRE.yml
  - docs/validation/**
updated: 2026-11-01T15:00Z
---
# Lane: s-j-retire-allowlist (repo vitana-v1)
Tasks in `tasks.md`. One `ALLOWLIST` line in the retire workflow. Governance path (`.github/**`), not a protected gate
file, so `executor: kiro` with the reviewer agent. The lane never dispatches the workflow (plan §3). VTID from
PLAN-SPAR; never by hand.

## Log
### 2026-11-01T15:00Z · kiro-hotmail-202611011402-f523 · ready
Lane created with the plan.
