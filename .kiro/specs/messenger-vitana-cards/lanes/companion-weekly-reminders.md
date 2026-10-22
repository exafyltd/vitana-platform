---
lane: companion-weekly-reminders
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
updated: 2026-10-22T08:05Z
---

Two recurring weekly moments (Vitana Index, diary) via `repeatAfterDays: 7`.
Depends on `companion-enrichment-moments` because both edit `moments.ts`
(shared hot file, §8a) — sequenced after it, not parallel.

### 2026-10-22T08:05Z · kiro-exafyltd-202610220802-4a74 · ready
Lane created by the plan author. Awaiting CI PLAN-SPAR convergence + VTID
allocation before build.
