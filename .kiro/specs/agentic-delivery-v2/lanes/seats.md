---
lane: seats
state: ready
next_actor: kiro
branch: kiro/agentic-delivery-v2/seats
depends_on: []
executor: kiro
seat: exafyltd
repos: [exafyltd/vitana-platform]
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - docs/programs/areas.yaml
  - .kiro/automations/exafy.md
  - .kiro/automations/exafyltd.md
  - .kiro/automations/jtadic.md
  - .kiro/automations/delta.md
  - .kiro/automations/echo.md
  - .kiro/automations/foxtrot.md
  - .kiro/automations/golf.md
  - .kiro/automations/hotel.md
  - .kiro/automations/india.md
  - .kiro/automations/juliet.md
  - .kiro/automations/kilo.md
  - scripts/collab/automations.test.mjs
updated: 2026-11-11T11:27Z
vtid: VTID-05712
---

# Lane: seats (repo exafyltd/vitana-platform)

Twelve Kiro seats by name, one automation file each, no address in any seat file (plan §3 C5). Starts only after
`privacy-ledger-auth/areas-emails` is done: both lanes edit `docs/programs/areas.yaml`.

## Log
### 2026-11-11T12:00Z · kiro-exafyltd-202611111044-8f1d · ready
Lane created with the plan.

### 2026-11-11T11:27Z · ci-plan-spar · ready (VTID allocated)
VTID-05712 allocated after policy approval (converged-auto-v1).
