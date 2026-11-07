---
lane: prereq-exit
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
reviewer_seat: hotmail
area: frontend
repos: [exafyltd/vitana-v1]
paths:
  - docs/validation/native-wave3/prereq-exit.md
updated: 2026-11-07T10:33Z
---
# Prerequisite exit gate — Wave 2 ledger and Wave 1 smoke (sentinel)
Plan: `.kiro/specs/native-wave3-release/` — `plan.md` (decision 1) and the `tasks.md` section marked
`<!-- lane: prereq-exit -->` (tasks P1–P2) are authoritative. VTID: assigned by CI after PLAN-SPAR converges.

**Goal.** Record machine evidence that the two exits Wave 3 depends on are met: every in-scope parity-ledger row is
native and parity-checked (Wave 2 exit, `NATIVE-APP-PLAN.md:198`), and the Wave 1 exit smoke is merged (Wave 1 row
`:196`). The lanes `store-declarations` and `beta-rollout-runbook` depend on this lane. Until both exits are met, this
lane stays open and records the blocker.

**Acceptance (reviewer: hotmail):** `docs/validation/native-wave3/prereq-exit.md` quotes the output of
`node scripts/native/parity-ledger.mjs --check` on `origin/main` and the in-scope status counts; it names the merged
Wave 1 smoke lane and the Health Sync module with their file paths. A missing item is recorded as a blocker, not
marked done.

**Never:** no VTID allocation by hand, no change to the ledger, no test against production.

## Log
### 2026-11-07T10:33Z · kiro-exafyltd-202611062257-540e · created → ready
Drafted with the plan. Measured on vitana-v1 `origin/main` `663d09a34`: 312 `not_started`, 121 `native`, 2
`exception` (435 rows). Wave 2 exit not met.
