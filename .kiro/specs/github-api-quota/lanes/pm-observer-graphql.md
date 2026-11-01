---
lane: pm-observer-graphql
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
  - services/gateway/src/services/project-manager/observe-live.ts
  - services/gateway/src/services/project-manager/observe-live-graphql.ts
  - services/gateway/test/project-manager/observe-live-graphql.test.ts
  - docs/validation/VTID-*/**
branch: kiro/github-api-quota/pm-observer-graphql
updated: 2026-11-01T14:00Z
---
# pm-observer-graphql — the PM observer reads open PRs in one GraphQL query per tick
Plan: `.kiro/specs/github-api-quota/plan.md` §2.3, §3 (D6, D7), §5 (`GithubReader` kept). Tasks: `tasks.md`
`pm-observer-graphql`. Depends on `gh-clients` (uses `github-rest.ts` as fallback) and `gh-graphql-core`. The PM is in
`dry_run` by default, so the staging proof is the fixture count, not a live tick.
## Log
### 2026-11-01T14:00Z · kiro-seat-exafy · created → ready
Lane created with the plan. Next: PLAN-SPAR; once `vtid:` is set, seat exafy claims it.
