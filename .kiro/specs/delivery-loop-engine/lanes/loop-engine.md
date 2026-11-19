---
lane: loop-engine
state: ready
next_actor: kiro
depends_on: [durable-events]
executor: kiro
seat: exafyltd
repos: [exafyltd/vitana-platform]
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - services/gateway/src/services/delivery-loop/types.ts
  - services/gateway/src/services/delivery-loop/gitlab-client.ts
  - services/gateway/src/services/delivery-loop/fingerprint.ts
  - services/gateway/src/services/delivery-loop/controls.ts
  - services/gateway/src/services/delivery-loop/facts.ts
  - services/gateway/src/services/delivery-loop/ledger.ts
  - services/gateway/src/services/delivery-loop/ports.ts
  - services/gateway/src/services/delivery-loop/keys.ts
  - services/gateway/src/services/delivery-loop/context.ts
  - services/gateway/src/services/delivery-loop/intents.ts
  - services/gateway/src/services/delivery-loop/intake.ts
  - services/gateway/src/services/delivery-loop/heal.ts
  - services/gateway/src/services/delivery-loop/drive.ts
  - services/gateway/src/services/delivery-loop/review.ts
  - services/gateway/src/services/delivery-loop/learn.ts
  - services/gateway/src/services/delivery-loop/labels.ts
  - services/gateway/src/services/delivery-loop/poll.ts
  - services/gateway/src/services/delivery-loop/engine.ts
  - services/gateway/src/services/delivery-loop/index.ts
  - services/gateway/test/delivery-loop/controls.test.ts
  - services/gateway/test/delivery-loop/gitlab-client.test.ts
  - services/gateway/test/delivery-loop/fingerprint.test.ts
  - services/gateway/test/delivery-loop/intake.test.ts
  - services/gateway/test/delivery-loop/heal.test.ts
  - services/gateway/test/delivery-loop/review.test.ts
  - services/gateway/test/delivery-loop/learn.test.ts
  - services/gateway/test/delivery-loop/engine.test.ts
  - services/gateway/test/delivery-loop/harness.ts
  - services/gateway/test/delivery-loop/fixtures/**
  - docs/validation/VTID-*/**
updated: 2026-11-19T19:50Z
---

# Lane: loop-engine (repo exafyltd/vitana-platform)

Plan §2. Tasks in `tasks.md`. VTID from CI PLAN-SPAR only; registration is blocked (`registration-blocked.md`).

## Log
### 2026-11-19T19:50Z · kiro-exafyltd-202611181014-b8e5 · ready
Lane created with the plan. Its code and tests exist on `kiro/delivery-loop-engine/gitlab-executor` (draft PR, no VTID).
