---
lane: approvals-auth-v2
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - services/gateway/src/routes/approvals.ts
  - services/gateway/src/services/orb-tools/developer-tools.ts
  - services/gateway/src/routes/orb-live.ts
  - services/gateway/src/routes/orb-tool.ts
  - services/gateway/test/mt-track-s-authz-approvals-auth.test.ts
  - services/gateway/test/orb-tools/developer-tools.test.ts
  - docs/validation/**
updated: 2026-11-03T15:25Z
vtid: VTID-05528
---
# Lane: approvals-auth-v2 (repo vitana-platform)
Supersedes `approvals-auth` (seat exafy, never built by that seat). The lane's paths cannot be amended from another seat, because lane permissions come from the base revision. This lane carries the same work, and `services/gateway/test/orb-tools/developer-tools.test.ts` (on main since e319c82ea5, changed by the approvals branch) is in scope. The code base is the approvals branch of PR #4606 (head d3f9a4a685). Tasks: `tasks.md`, group `approvals-auth-v2`. The VTID is allocated by CI on convergence.

## Log
### 2026-11-03T14:20Z · kiro-hotmail-202611011452-6d16 · created
Created by plan amendment 1 (mt-track-s-authz).

### 2026-11-03T15:25Z · ci-plan-spar · ready (VTID allocated)
VTID-05528 allocated after policy approval (converged-auto-v1).
