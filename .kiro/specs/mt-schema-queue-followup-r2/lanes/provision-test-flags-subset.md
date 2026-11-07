---
lane: provision-test-flags-subset
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - supabase/tests/vtid_05150_provision_tenant.test.sql
updated: 2026-11-07T20:00Z
repos: [exafyltd/vitana-platform]
---
# provision-test-flags-subset — feature_flags expectation tolerates erp key — mt-schema-queue-followup-r2

Plan: `../plan.md` and the `provision-test-flags-subset` group of `../tasks.md`. The VTID comes from PLAN-SPAR on convergence, never by hand.
Rules (§7a): no VTID allocation, no merge outside §7b, no deploy, no live write. Branch
`kiro/mt-schema-queue-followup-r2/provision-test-flags-subset`; PR title `VTID-xxxxx (mt-schema-queue-followup-r2/provision-test-flags-subset): …`.

## Log
### 2026-11-07T20:00Z · kiro-hotmail-202611061752-cc1f · created → ready
Created with the plan.
