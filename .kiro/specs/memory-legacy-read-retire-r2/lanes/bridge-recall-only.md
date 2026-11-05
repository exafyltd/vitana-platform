---
lane: bridge-recall-only
state: in-review
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: platform
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - services/gateway/src/services/orb-memory-bridge.ts
  - services/gateway/src/services/orb-memory-bridge-repository.ts
  - services/gateway/src/services/memory/recall-shadow.ts
  - services/gateway/test/services/memory/**
  - services/gateway/test/services/orb-memory-bridge.test.ts
  - services/gateway/test/routes/orb-live.test.ts
  - services/gateway/test/vtid-05147-effective-role-permitted.test.ts
  - docs/MEMORY-SYSTEM-PLAN.md
  - docs/validation/VTID-*/**
updated: 2026-11-05T12:30Z
claimed_by: kiro-exafyltd-202611042048-44bc
branch: kiro/memory-legacy-read-retire-r2/bridge-recall-only
pr: https://github.com/exafyltd/vitana-platform/pull/4701
vtid: VTID-05556
---
# bridge-recall-only — the ORB memory read is recall() only (vitana-platform)
Plan: `.kiro/specs/memory-legacy-read-retire-r2/plan.md`. **Held until PLAN-SPAR allocates this lane's VTID.**

## Log
### 2026-11-05T11:45Z · kiro-exafyltd-202611042048-44bc · created → ready
Created and held. A local prototype on `29b639da` exists (red 4/5 on origin/main for the new wiring test; 73/73 across the three bridge test files with the change).

### 2026-11-05T11:55Z · ci-plan-spar · ready (VTID allocated)
VTID-05556 allocated after policy approval (converged-auto-v1).

### 2026-11-05T12:25Z · kiro-exafyltd-202611042048-44bc · ready → executing
Claimed. Built from the local prototype, rebased on `3b5292f6`. Red on origin/main: 6 failed / 54 passed (lane tests on main
code); green on the head: 180/180 across the six affected suites, memory suites 48/48, `tsc --noEmit` clean. Evidence in
`docs/validation/VTID-05556/` (`land-guard evidence` ok; preflight passes).

### 2026-11-05T12:30Z · kiro-exafyltd-202611042048-44bc · executing → in-review
exafyltd/vitana-platform#4701, head `8a33f5aa`. Next: reviewer agent `vitana-lane-reviewer` on the current head. Merge also
waits on AC-6 / D1, the read-only 14-day production count of not-ok recalls, which this session cannot take (no AWS
credentials).
