---
lane: beta-rollout-runbook
state: ready
next_actor: kiro
depends_on: [prereq-exit]
executor: kiro
seat: exafyltd
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
reviewer_seat: agent:vitana-lane-reviewer
area: frontend
repos: [exafyltd/vitana-v1]
paths:
  - docs/validation/native-wave3/beta-rollout-runbook.md
  - docs/validation/VTID-*/scope.json
  - docs/validation/VTID-*/plan-sparring.md
updated: 2026-11-08T12:07Z
vtid: VTID-05655
---
# Beta and phased-rollout runbook (internal, TestFlight, closed track, 1 → 10 → 50 → 100 %)
Plan: `.kiro/specs/native-wave3-release-r2/` — `plan.md` (decision 5) and the `tasks.md` section marked
`<!-- lane: beta-rollout-runbook -->` (tasks R1–R3) are authoritative. VTID: assigned by CI after PLAN-SPAR converges.

**Goal.** One runbook that the owner and the on-call session can follow: the beta cohort of staff and volunteer
members (named by the owner), the feedback channel, the ramp steps, the halt rule (crash-free sessions below 99.5 % or an
adoption regression stops the ramp), and the in-app kill switch in `apps/mobile/src/config/remote-config.ts`.

**Acceptance (reviewer: hotmail):** the runbook names each owner action (App Store phased release, Play staged rollout)
without performing it; it states the halt rule with its thresholds from the program row; it does not change code.

**Never:** no store console action by a session, no cohort member added by a session, no production write.

## Log
### 2026-11-08T12:30Z · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan (re-plan of `native-wave3-release/beta-rollout-runbook`, PR #4770).

### 2026-11-08T12:07Z · ci-plan-spar · ready (VTID allocated)
VTID-05655 allocated after policy approval (converged-auto-v1).
