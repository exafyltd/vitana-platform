---
lane: ci-scripts-backoff
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
  - scripts/collab/github-backoff.mjs
  - scripts/collab/github-backoff.test.mjs
  - scripts/collab/land-guard.mjs
  - docs/validation/VTID-*/**
branch: kiro/github-api-quota/ci-scripts-backoff
updated: 2026-11-01T14:00Z
---
# ci-scripts-backoff — land guard reads back off until the reset time
Plan: `.kiro/specs/github-api-quota/plan.md` §4 and §5 (`github-backoff.mjs` interface). Tasks: `tasks.md`
`ci-scripts-backoff`. Governance path (`scripts/collab/**`): the reviewer accept on the current head is required
(collaboration §3a). Not on the protected list. The merge request stays a single call.
## Log
### 2026-11-01T14:00Z · kiro-seat-exafy · created → ready
Lane created with the plan. Next: PLAN-SPAR; once `vtid:` is set, seat exafy claims it.
