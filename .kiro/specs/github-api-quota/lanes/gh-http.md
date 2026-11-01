---
lane: gh-http
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafy
area: platform
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
reviewer_seat: agent:vitana-lane-reviewer
repos: [exafyltd/vitana-platform]
paths:
  - services/gateway/src/services/github/github-http.ts
  - services/gateway/test/github-http-cache-backoff.test.ts
  - docs/validation/VTID-*/**
branch: kiro/github-api-quota/gh-http
updated: 2026-11-01T14:00Z
---
# gh-http — shared rate-limit classifier, blocked-until state and GET cache
Plan: `.kiro/specs/github-api-quota/plan.md` §3 (D1-D5) and §5 (interface). Tasks: `tasks.md` `gh-http`. New files only; no
existing file changes. Every other lane imports this module.
## Log
### 2026-11-01T14:00Z · kiro-seat-exafy · created → ready
Lane created with the plan. Next: PLAN-SPAR; once `vtid:` is set, seat exafy claims it.
