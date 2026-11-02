---
lane: s-j-retire-allowlist-v2
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
  - src/lib/supabase-functions-retire.vtid-05008.test.ts
  - docs/validation/**
updated: 2026-11-02T12:21Z
vtid: VTID-05463
---
# Lane: s-j-retire-allowlist-v2 (repo vitana-v1)
Supersedes `s-j-retire-allowlist` (never built): the `ALLOWLIST` line and the VTID-05008 test's `RETIRED` entry land in
one PR. Tasks in `tasks.md`. Governance path (`.github/**`), not a protected gate file. The lane never dispatches the
workflow (plan §3). VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-02T11:10Z · kiro-hotmail-202611011452-6d16 · created
Created through `_plan`; the old lane's one-line change fails `src/lib/supabase-functions-retire.vtid-05008.test.ts`.

### 2026-11-02T12:21Z · ci-plan-spar · ready (VTID allocated)
VTID-05463 allocated after policy approval (converged-auto-v1).
