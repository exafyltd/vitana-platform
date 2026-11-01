---
lane: gh-clients
state: ready
next_actor: kiro
depends_on: [gh-http]
executor: kiro
seat: exafy
area: platform
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
reviewer_seat: agent:vitana-lane-reviewer
repos: [exafyltd/vitana-platform]
paths:
  - services/gateway/src/services/github-service.ts
  - services/gateway/src/services/project-manager/github-rest.ts
  - services/gateway/test/github-rate-limit-propagation.test.ts
  - docs/validation/VTID-*/**
branch: kiro/github-api-quota/gh-clients
updated: 2026-11-01T14:00Z
---
# gh-clients — REST reads and writes through the shared module; no false green
Plan: `.kiro/specs/github-api-quota/plan.md` §2.1-2.3, §3 (D1, D4, D5, D9). Tasks: `tasks.md` `gh-clients`. Depends on
`gh-http` (imports `githubFetch`). This lane is the first editor of `github-service.ts`; `gh-graphql-wire` edits it
after this lane merges.
## Log
### 2026-11-01T14:00Z · kiro-seat-exafy · created → ready
Lane created with the plan. Next: PLAN-SPAR; once `vtid:` is set, seat exafy claims it.
