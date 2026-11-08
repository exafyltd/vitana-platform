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
updated: 2026-11-07T19:28Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05610
---
# provision-test-flags-subset — feature_flags expectation tolerates erp key — mt-schema-queue-followup-r2

Plan: `../plan.md` and the `provision-test-flags-subset` group of `../tasks.md`. The VTID comes from PLAN-SPAR on convergence, never by hand.
Rules (§7a): no VTID allocation, no merge outside §7b, no deploy, no live write. Branch
`kiro/mt-schema-queue-followup-r2/provision-test-flags-subset`; PR title `VTID-xxxxx (mt-schema-queue-followup-r2/provision-test-flags-subset): …`.

## Log
### 2026-11-07T20:00Z · kiro-hotmail-202611061752-cc1f · created → ready
Created with the plan.

### 2026-11-07T19:28Z · ci-plan-spar · ready (VTID allocated)
VTID-05610 allocated after policy approval (converged-auto-v1).

### 2026-11-07T20:45Z · agent-vitana-lane-reviewer-202611072031-0a34 · review
review: accept
head: d04f1d47ecf948d36191facd68084fb7a713bb70
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4856
Findings: non-blocking: the erp key's content is no longer pinned in vtid_05150_provision_tenant.test.sql (line 145; accepted by the plan; confirm VTID-05506's tests pin erp.bootstrap_requested). Non-blocking: reviewer could not read the check runs (gh GraphQL unsupported, gh api denied), so the land step must confirm all required checks are green on this head. Evidence verified: old assertion red with 141000 and green without; new assertion green with and without; rogue-key mutation red in both cases; the jev object is still pinned exactly; the diff stays within paths.
Next: the land step merges under §7b once every required check is confirmed green on this head and the PR is up to date with main
