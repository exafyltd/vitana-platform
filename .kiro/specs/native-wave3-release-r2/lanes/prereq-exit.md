---
lane: prereq-exit
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
reviewer_seat: agent:vitana-lane-reviewer
area: frontend
repos: [exafyltd/vitana-v1]
paths:
  - docs/validation/native-wave3/prereq-exit.md
updated: 2026-11-08T12:07Z
vtid: VTID-05662
---
# Prerequisite exit gate — Wave 2 ledger and Wave 1 smoke (sentinel)
Plan: `.kiro/specs/native-wave3-release-r2/` — `plan.md` (decision 1) and the `tasks.md` section marked
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
### 2026-11-08T12:30Z · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan (re-plan of `native-wave3-release/prereq-exit`, PR #4770).

### 2026-11-08T12:07Z · ci-plan-spar · ready (VTID allocated)
VTID-05662 allocated after policy approval (converged-auto-v1).
