---
lane: companion-enrichment-signals
state: ready
next_actor: kiro
depends_on: []
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

Bulk enrichment completion + `user_enrichment_cards` dismissal reads, the
`FetchEnrichmentCompletions` tick-deps seam, and the `MemberContext` fields that
feed `eligibleEnrichmentCards`. Dependency for the moments lane. Shares
companion files with the moments lane (sequenced, §8a).

### 2026-10-22T08:20Z · kiro-exafyltd-202610220802-4a74 · ready
Created in sparring round-1 rewrite (R1-F4/R1-F5): the enrichment resolver is
per-member with no bulk form, so the bulk read is its own lane. Awaiting CI
PLAN-SPAR convergence + VTID allocation before build.
