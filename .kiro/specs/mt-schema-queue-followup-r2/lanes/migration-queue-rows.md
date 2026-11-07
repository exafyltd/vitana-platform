---
lane: migration-queue-rows
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - docs/multitenancy/MIGRATION-QUEUE.md
updated: 2026-11-07T19:28Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05609
---
# migration-queue-rows — queue rows for VTID-05575 and VTID-05573 — mt-schema-queue-followup-r2

Plan: `../plan.md` and the `migration-queue-rows` group of `../tasks.md`. The VTID comes from PLAN-SPAR on convergence, never by hand.
Rules (§7a): no VTID allocation, no merge outside §7b, no deploy, no live write. Branch
`kiro/mt-schema-queue-followup-r2/migration-queue-rows`; PR title `VTID-xxxxx (mt-schema-queue-followup-r2/migration-queue-rows): …`.

## Log
### 2026-11-07T20:00Z · kiro-hotmail-202611061752-cc1f · created → ready
Created with the plan.

### 2026-11-07T19:28Z · ci-plan-spar · ready (VTID allocated)
VTID-05609 allocated after policy approval (converged-auto-v1).
