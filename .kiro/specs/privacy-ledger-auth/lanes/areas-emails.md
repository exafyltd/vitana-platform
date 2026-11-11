---
lane: areas-emails
state: ready
next_actor: kiro
branch: kiro/privacy-ledger-auth/areas-emails
depends_on: []
executor: kiro
seat: exafyltd
repos: [exafyltd/vitana-platform]
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - docs/programs/areas.yaml
  - scripts/collab/areas-no-email.test.mjs
updated: 2026-11-11T11:40Z
---

# Lane: areas-emails (repo exafyltd/vitana-platform)

Removes the account addresses from the seat file and adds a test that keeps them out. Tasks T1-T4 in `tasks.md`.

## Log
### 2026-11-11T11:40Z · kiro-exafyltd-202611111044-8f1d · ready
Lane created with the plan. Paths are the two files the change needs.
