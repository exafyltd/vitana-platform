---
lane: gh-graphql-core
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
  - services/gateway/src/services/github/graphql-client.ts
  - services/gateway/src/services/github/graphql-mapping.ts
  - services/gateway/test/github-graphql-mapping.test.ts
  - docs/validation/VTID-*/**
branch: kiro/github-api-quota/gh-graphql-core
updated: 2026-11-01T14:00Z
---
# gh-graphql-core — GraphQL transport and pure mapping
Plan: `.kiro/specs/github-api-quota/plan.md` §3 (D6-D8) and §5 (`graphql-client.ts`, `graphql-mapping.ts`). Tasks:
`tasks.md` `gh-graphql-core`. Depends on `gh-http` (uses `githubFetch` and `GithubRateLimitError`). New files only.
## Log
### 2026-11-01T14:00Z · kiro-seat-exafy · created → ready
Lane created with the plan. Next: PLAN-SPAR; once `vtid:` is set, seat exafy claims it.
