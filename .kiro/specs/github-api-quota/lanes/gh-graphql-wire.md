---
lane: gh-graphql-wire
state: ready
next_actor: kiro
depends_on: [gh-clients, gh-graphql-core]
executor: kiro
seat: exafy
area: platform
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
reviewer_seat: agent:vitana-lane-reviewer
repos: [exafyltd/vitana-platform]
paths:
  - services/gateway/src/services/github-service.ts
  - services/gateway/test/github-graphql-wire.test.ts
  - services/gateway/test/vtid-04218-pipeline-resilience.test.ts
  - services/gateway/test/worker-orchestrator-await-autopilot.test.ts
  - services/gateway/test/vtid-03835-github-service-read-access.test.ts
  - services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  - services/gateway/test/operator-pipeline/fake-operator-platform.ts
  - docs/validation/VTID-*/**
branch: kiro/github-api-quota/gh-graphql-wire
updated: 2026-11-01T14:00Z
---
# gh-graphql-wire — getPrStatus and listOpenPrsWithStatus read GraphQL, REST as fallback
Plan: `.kiro/specs/github-api-quota/plan.md` §2.2, §3 (D6-D8). Tasks: `tasks.md` `gh-graphql-wire`. Depends on
`gh-clients` (same file, runs after it) and `gh-graphql-core` (the query client and mapper). The five existing test
files are listed because they pin the REST shape of these two functions; each change to them is logged with its reason.
Run the full gateway suite (`npm test`) before the PR is ready.
## Log
### 2026-11-01T14:00Z · kiro-seat-exafy · created → ready
Lane created with the plan. Next: PLAN-SPAR; once `vtid:` is set, seat exafy claims it.
