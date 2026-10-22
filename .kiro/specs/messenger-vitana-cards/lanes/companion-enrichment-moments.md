---
lane: companion-enrichment-moments
state: ready
next_actor: kiro
depends_on: [companion-enrichment-signals]
executor: kiro
seat: exafy
area: platform
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - services/gateway/src/services/companion/**
  - services/gateway/test/**
updated: 2026-10-22T08:20Z
---

The 11 E1–E11 enrichment moments only, gated through `eligibleEnrichmentCards`
(completion AND dismissal). No F1/F7/F8 and no Index/diary moments — those are
shipped (VTID-05101) and retained unchanged. Depends on
`companion-enrichment-signals` (needs the MemberContext fields) and shares
`moments.ts` with it (sequenced, §8a).

### 2026-10-22T08:20Z · kiro-exafyltd-202610220802-4a74 · ready
Rescoped in sparring round-1 rewrite (R1-F1): F1/F7/F8 removed (already
shipped); lane now adds ONLY E1–E11. Awaiting CI PLAN-SPAR convergence + VTID
allocation before build.
