---
lane: bridge-recall-only
state: ready
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
updated: 2026-11-05T11:45Z
---
# bridge-recall-only — the ORB memory read is recall() only (vitana-platform)
Plan: `.kiro/specs/memory-legacy-read-retire-r2/plan.md`. **Held until PLAN-SPAR allocates this lane's VTID.**

## Log
### 2026-11-05T11:45Z · kiro-exafyltd-202611042048-44bc · created → ready
Created and held. A local prototype on `29b639da` exists (red 4/5 on origin/main for the new wiring test; 73/73 across the three bridge test files with the change).
