---
lane: gitlab-executor
state: ready
next_actor: kiro
depends_on: [loop-engine]
executor: kiro
seat: exafyltd
repos: [exafyltd/vitana-platform]
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - services/gateway/src/services/autopilot-agent/gitlab-target.ts
  - services/gateway/src/services/autopilot-agent/agent-workspace.ts
  - services/gateway/src/services/autopilot-agent/run-agent-execution.ts
  - services/gateway/src/services/dev-autopilot-execute.ts
  - services/gateway/src/services/dev-autopilot-bridge.ts
  - services/gateway/src/services/dev-autopilot-gitlab-repair.ts
  - services/gateway/src/services/delivery-loop/dev-autopilot-gateway.ts
  - services/gateway/test/autopilot-agent-gitlab-target.test.ts
  - services/gateway/test/autopilot-agent-workspace-gitlab.test.ts
  - services/gateway/test/dev-autopilot-bridge-gitlab-guards.test.ts
  - services/gateway/test/dev-autopilot-gitlab-repair.test.ts
  - services/gateway/test/delivery-loop/dev-autopilot-gateway.test.ts
  - services/gateway/test/operator-pipeline/harness.ts
  - services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  - services/gateway/test/vtid-04466-exploration-budget.test.ts
  - docs/validation/VTID-*/**
updated: 2026-11-19T19:50Z
---

# Lane: gitlab-executor (repo exafyltd/vitana-platform)

Plan §2. Tasks in `tasks.md`. VTID from CI PLAN-SPAR only; registration is blocked (`registration-blocked.md`).

## Log
### 2026-11-19T19:50Z · kiro-exafyltd-202611181014-b8e5 · ready
Lane created with the plan. Its code and tests exist on `kiro/delivery-loop-engine/gitlab-executor` (draft PR, no VTID).
