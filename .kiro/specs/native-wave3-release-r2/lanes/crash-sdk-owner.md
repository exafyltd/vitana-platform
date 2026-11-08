---
lane: crash-sdk-owner
state: ready
next_actor: kiro
depends_on: [crash-port]
executor: kiro
seat: exafyltd
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
reviewer_seat: agent:vitana-lane-reviewer
area: frontend
repos: [exafyltd/vitana-v1]
paths:
  - docs/validation/native-wave3/crash-sdk.md
updated: 2026-11-08T12:07Z
vtid: VTID-05660
---
# OWNER GATE — crash-reporting SDK and Firebase ownership (§8 decision 5; not built)
Plan: `.kiro/specs/native-wave3-release-r2/` — `plan.md` (owner gates) and the `tasks.md` section marked
`<!-- lane: crash-sdk-owner -->` (task O3) are authoritative.

**OWNER GATE — no SDK is added by a session.** The owner picks the crash-reporting SDK behind `crash-port`, and states
who owns the Firebase project or whether a new one is created (`NATIVE-APP-PLAN.md:222` §8 decision 5). The decision is
recorded in `docs/validation/native-wave3/crash-sdk.md`. The crash-free gate of the plan (≥99.5 %) is measured through
that SDK.

**Next actor is the owner.**

## Log
### 2026-11-08T12:30Z · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan (re-plan of `native-wave3-release/crash-sdk-owner`, PR #4770).

### 2026-11-08T12:07Z · ci-plan-spar · ready (VTID allocated)
VTID-05660 allocated after policy approval (converged-auto-v1).
