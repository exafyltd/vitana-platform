---
lane: messenger-surface-wiring
state: ready
next_actor: kiro
depends_on: [companion-enrichment-moments]
executor: kiro
seat: exafy
area: platform
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - services/gateway/src/services/companion/**
  - services/gateway/test/**
  - docs/validation/**
updated: 2026-10-22T08:05Z
---

Surface wiring + run-mode doc + read-only staging test + one-per-day pacing
test. Depends on `companion-enrichment-moments` for the moments to exist.

### 2026-10-22T08:05Z · kiro-exafyltd-202610220802-4a74 · ready
Lane created by the plan author. Awaiting CI PLAN-SPAR convergence + VTID
allocation before build.
