---
lane: gateway-live-series
state: ready
next_actor: kiro
depends_on: [db-live-series]
executor: kiro
seat: exafy
area: platform
repos: [exafyltd/vitana-platform]
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - services/gateway/src/services/live-series.ts
  - services/gateway/src/routes/live.ts
  - services/gateway/src/services/live-series*.ts
  - services/gateway/test/live-room-series*.test.ts
updated: 2026-11-06T08:45Z
---

# Lane: gateway-live-series (repo exafyltd/vitana-platform)

Create with `recurrence`, edit with `scope`, series cancel, hourly rolling window. Plan: `plan.md` Interfaces 2 to 4.
Depends on `gateway-cohost` (shared `routes/live.ts`, `live-cohosts.ts`). Tasks in `tasks.md`.

## Log
### 2026-11-06T08:45Z · claude-code session_01Cp885FGVuZp27dQmDP6eMH · ready
Lane created with the plan. Not claimed.
