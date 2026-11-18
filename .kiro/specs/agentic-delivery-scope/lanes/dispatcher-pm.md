---
lane: dispatcher-pm
state: ready
next_actor: kiro
depends_on: [dispatcher]
executor: kiro
seat: exafyltd
repos: [exafyltd/vitana-platform]
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - services/gateway/src/services/project-manager/types.ts
  - services/gateway/src/services/project-manager/decide.ts
  - services/gateway/src/services/project-manager/act.ts
  - services/gateway/test/project-manager/retry-act.test.ts
updated: 2026-11-11T16:49Z
vtid: VTID-05736
---

# Lane: dispatcher-pm (repo exafyltd/vitana-platform)

Wires the retry schedule of lane `dispatcher` into the Project Manager: the `retry` decision kind, its decide rule and its act handler through the existing pm-agent lane writer (plan §5). Tasks in `tasks.md`.

## Log
### 2026-11-11T16:41Z · kiro-exafyltd-202611111044-8f1d · ready
Lane created with the plan (round 1, R1-F2).

### 2026-11-11T16:49Z · ci-plan-spar · ready (VTID allocated)
VTID-05736 allocated after policy approval (converged-auto-v1).
