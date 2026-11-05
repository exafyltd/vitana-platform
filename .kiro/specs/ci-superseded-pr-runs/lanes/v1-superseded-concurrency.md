---
lane: v1-superseded-concurrency
state: ready
next_actor: kiro
branch: kiro/ci-superseded-pr-runs/v1-superseded-concurrency
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
repos: [exafyltd/vitana-v1]
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - .github/workflows/SQL-CALENDAR-ENTRY-SHARE.yml
  - .github/workflows/SQL-EVENT-SHARE-POSTS.yml
  - .github/workflows/SQL-GROUP-PARTICIPANTS.yml
  - .github/workflows/SQL-THREAD-JOIN-HARDENING.yml
  - .github/workflows/STAGING-TESTS-REQUIRED.yml
  - .github/workflows/i18n-check.yml
updated: 2026-11-02T16:31Z
vtid: VTID-05514
---

# Lane: v1-superseded-concurrency (repo exafyltd/vitana-v1)

Adds the superseded-run concurrency block to six PR-triggered workflows in vitana-v1. Tasks T1-T5 in tasks.md.

## Log
### 2026-11-02T15:20Z · kiro-exafyltd-202611021510-092e · ready
Lane created with the plan. Paths are the exact files changed by the prepared commit.

### 2026-11-02T16:31Z · ci-plan-spar · ready (VTID allocated)
VTID-05514 allocated after policy approval (converged-auto-v1).
