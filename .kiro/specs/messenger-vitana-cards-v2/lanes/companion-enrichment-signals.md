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
  - docs/validation/**
updated: 2026-10-31T13:40Z
vtid: VTID-05367
---

Bulk enrichment completion + `user_enrichment_cards` dismissal reads, the
`FetchEnrichmentCompletions` tick-deps seam, and the `MemberContext` fields that
feed `eligibleEnrichmentCards`. Dependency for the moments lane. Shares
companion files with the moments lane (sequenced, ┬º8a).

Contract (R2-F2): the seam uses `Promise.allSettled` / `unavailable[]` like
`fetchMemberSignals` and NEVER throws, so a DB error cannot abort the whole tick
(it is in the `Promise.all` at `companion-service.ts:131`). Test: profiles query
rejects ΓåÆ empty map + `unavailable:['enrichment_profiles']`, tick continues.

Contract (R3-F1): this lane also computes the eligible set in the tick loop
(real `now` in scope) and stores `eligibleEnrichmentCardTypes:
ReadonlySet<EnrichmentCardType>` on `MemberContext` via
`eligibleEnrichmentCards(completions, dismissRows, 'messenger', now,
unavailableEnrichmentCards())` ΓÇö so moments never need `now`.

Contract (R1-F3, s2): initialize every member's completion map to `false` for
all 11 card types BEFORE applying query rows (`eligibleEnrichmentCards` needs
`=== false`, not `undefined`). A member with no `profiles` row must yield
E1/E2/E4/E5/E11 = false (eligible). Test fixture includes such a member.

### 2026-10-22T08:20Z ┬╖ kiro-exafyltd-202610220802-4a74 ┬╖ ready
Created in sparring round-1 rewrite (R1-F4/R1-F5): the enrichment resolver is
per-member with no bulk form, so the bulk read is its own lane. Awaiting CI
PLAN-SPAR convergence + VTID allocation before build.

### 2026-10-28T10:29Z · ci-plan-spar · ready (VTID allocated)
VTID-05367 allocated after policy approval (converged-auto-v1).

### 2026-10-31T13:40Z · kiro-exafyltd-202610220802-4a74 · paths
Added `docs/validation/**` to `paths` before the plan lands on main: the lane PR
must carry `docs/validation/VTID-05367/{staging-tests.json,acceptance.md}`
(CLAUDE.md rule 47 "no suite, no merge"; PR-GATE `change-suite` / `validate-pr`).
Same path every other plan's lanes declare. No other change.
