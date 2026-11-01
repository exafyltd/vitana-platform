---
lane: polling-cadence
state: ready
next_actor: kiro
depends_on: [gh-clients]
executor: kiro
seat: exafy
area: platform
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
reviewer_seat: agent:vitana-lane-reviewer
repos: [exafyltd/vitana-platform]
paths:
  - services/gateway/src/services/dev-autopilot-watcher.ts
  - services/gateway/src/routes/cicd.ts
  - services/gateway/test/github-polling-cadence.test.ts
  - docs/validation/VTID-*/**
branch: kiro/github-api-quota/polling-cadence
updated: 2026-11-01T14:00Z
---
# polling-cadence — lower watcher and route polling; skip calls while rate-limited
Plan: `.kiro/specs/github-api-quota/plan.md` §2.4, §3 (D10, D11). Tasks: `tasks.md` `polling-cadence`. Depends on
`gh-clients` (the rate-limit error type and `isRateLimited`). The plan driver heartbeat is not changed (D11). The
2-minute latency increase is an intended change and is written into the PR body.
## Log
### 2026-11-01T14:00Z · kiro-seat-exafy · created → ready
Lane created with the plan. Next: PLAN-SPAR; once `vtid:` is set, seat exafy claims it.
