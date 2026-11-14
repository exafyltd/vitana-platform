---
lane: dispatcher
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
repos: [exafyltd/vitana-platform]
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - services/gateway/src/services/project-manager/retry.ts
  - services/gateway/src/services/project-manager/decide.ts
  - services/gateway/src/services/project-manager/types.ts
  - services/gateway/test/project-manager/retry.test.ts
updated: 2026-11-11T16:49Z
vtid: VTID-05737
---

# Lane: dispatcher (repo exafyltd/vitana-platform)

Project Manager `retry` decisions with backoff instead of questions (plan §5). Tasks in `tasks.md`.

## Log
### 2026-11-11T16:23Z · kiro-exafyltd-202611111044-8f1d · ready
Lane created with the plan.

### 2026-11-11T16:49Z · ci-plan-spar · ready (VTID allocated)
VTID-05737 allocated after policy approval (converged-auto-v1).
