---
lane: beta-rollout-runbook
state: ready
next_actor: kiro
depends_on: [prereq-exit]
executor: kiro
seat: exafyltd
reviewer_seat: hotmail
area: frontend
repos: [exafyltd/vitana-v1]
paths:
  - docs/validation/native-wave3/beta-rollout-runbook.md
  - docs/validation/VTID-*/scope.json
  - docs/validation/VTID-*/plan-sparring.md
updated: 2026-11-08T11:36Z
vtid: VTID-05627
---
# Beta and phased-rollout runbook (internal, TestFlight, closed track, 1 → 10 → 50 → 100 %)
Plan: `.kiro/specs/native-wave3-release/` — `plan.md` (decision 5) and the `tasks.md` section marked
`<!-- lane: beta-rollout-runbook -->` (tasks R1–R3) are authoritative. VTID: assigned by CI after PLAN-SPAR converges.

**Goal.** One runbook that the owner and the on-call session can follow: the beta cohort of staff and volunteer
members (named by the owner), the feedback channel, the ramp steps, the halt rule (crash-free sessions below 99.5 % or an
adoption regression stops the ramp), and the in-app kill switch in `apps/mobile/src/config/remote-config.ts`.

**Acceptance (reviewer: hotmail):** the runbook names each owner action (App Store phased release, Play staged rollout)
without performing it; it states the halt rule with its thresholds from the program row; it does not change code.

**Never:** no store console action by a session, no cohort member added by a session, no production write.

## Log
### 2026-11-07T10:33Z · kiro-exafyltd-202611062257-540e · created → ready
Drafted with the plan. Held by `depends_on: [prereq-exit]`.

### 2026-11-08T11:36Z · ci-plan-spar · ready (VTID allocated)
VTID-05627 allocated after policy approval (converged-auto-v1).
