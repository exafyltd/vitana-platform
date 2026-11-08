---
lane: appilix-retire
state: ready
next_actor: kiro
depends_on: [client-identity-gateway, store-submission-owner, beta-rollout-runbook]
executor: kiro
seat: exafyltd
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
reviewer_seat: agent:vitana-lane-reviewer
area: frontend
repos: [exafyltd/vitana-v1]
updated: 2026-11-08T12:07Z
vtid: VTID-05654
---
# OWNER GATE — retire Appilix push and bridge code after the adoption threshold (not built)
Plan: `.kiro/specs/native-wave3-release-r2/` — `plan.md` (decision 6) and the `tasks.md` section marked
`<!-- lane: appilix-retire -->` (tasks A1–A2) are authoritative.

**OWNER GATE — the gate opens only on measured data.** The owner opens it when the gateway count shows ≥95 % of active
mobile members on `native` for the last ramp step and the crash-free gate holds (program row `NATIVE-APP-PLAN.md:199`).
Only then does the lane get its `paths`: the Appilix push and bridge code across the 106 files under `vitana-v1:src/`
that reference Appilix, fixed against `origin/main` at that time. Until then it has no paths and no session edits it.

**Next actor is the owner.** A migration notice for Appilix-only members is required first (`NATIVE-APP-PLAN.md:120`).

## Log
### 2026-11-08T12:30Z · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan (re-plan of `native-wave3-release/appilix-retire`, PR #4770).

### 2026-11-08T12:07Z · ci-plan-spar · ready (VTID allocated)
VTID-05654 allocated after policy approval (converged-auto-v1).
