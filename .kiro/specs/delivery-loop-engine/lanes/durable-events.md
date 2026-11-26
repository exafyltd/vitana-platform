---
lane: durable-events
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
repos: [exafyltd/vitana-platform]
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - services/gateway/src/services/oasis-event-service.ts
  - services/gateway/src/types/cicd.ts
  - services/gateway/src/services/gitlab-events/delivery-mapper.ts
  - services/gateway/src/services/gitlab-events/delivery-stage.ts
  - services/gateway/test/delivery/command-hub-delivery.test.ts
  - services/gateway/test/delivery/delivery-host-guard.test.ts
  - services/gateway/test/delivery/delivery-route.test.ts
  - services/gateway/test/delivery/fixtures.ts
  - services/gateway/test/delivery/gitlab-delivery-mapping.test.ts
  - services/gateway/test/delivery/gitlab-delivery-oasis-write.test.ts
  - services/gateway/test/delivery/gitlab-delivery-webhook.test.ts
  - services/gateway/test/oasis-event-idempotency.test.ts
  - docs/validation/VTID-*/**
updated: 2026-11-19T19:50Z
---

# Lane: durable-events (repo exafyltd/vitana-platform)

Plan §2. Tasks in `tasks.md`. VTID from CI PLAN-SPAR only; registration is blocked (`registration-blocked.md`).

## Log
### 2026-11-19T19:50Z · kiro-exafyltd-202611181014-b8e5 · ready
Lane created with the plan. Its code and tests exist on `kiro/delivery-loop-engine/gitlab-executor` (draft PR, no VTID).
