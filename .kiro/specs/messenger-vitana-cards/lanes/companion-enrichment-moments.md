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

The 11 E1–E11 enrichment moments only, gated through
`eligibleEnrichmentCards(completions, dismissRows, screen, now,
unavailableEnrichmentCards())` — completion AND dismissal AND availability.
No F1/F7/F8 and no Index/diary moments — those are shipped (VTID-05101) and
retained unchanged. Depends on `companion-enrichment-signals` (needs the
MemberContext fields) and shares `moments.ts` with it (sequenced, §8a).

Contracts:
- R2-F1: pass `unavailableEnrichmentCards()` as the 5th arg; with Meta OAuth
  unset (every current stack) E6/E7 are NOT offered. Test: no E6/E7 moment when
  `INSTAGRAM_CLIENT_ID`/`FACEBOOK_CLIENT_ID` absent, regardless of completion.
- R2-F3: do NOT use `EligibleEnrichmentCard.priority` (1-based, lower=better) as
  the moment priority. Assign each moment an explicit companion-scale priority
  in 20–49 (above featureTip 20, below vitanaIndex 50), E1 highest → E11 lowest.
  Priority-pin test asserts absolute values.
- R3-F1: moments read `ctx.eligibleEnrichmentCardTypes` (the pre-computed set
  from the signals lane, built with the tick's real `now`). Moments never call
  `eligibleEnrichmentCards` and never construct a `Date` from `localDate`. Test:
  dismissed E8 at T → null at T+3d, fires at T+8d.
- R3-F2: each moment's `intent` is an English composer instruction (featureTip
  pattern); `ENRICHMENT_CARD_TIPS[Ex].title.en`/`.description.en` go in `facts`
  (`card_title`/`card_description`), never used as the `intent` string.

### 2026-10-22T08:20Z · kiro-exafyltd-202610220802-4a74 · ready
Rescoped in sparring round-1 rewrite (R1-F1): F1/F7/F8 removed (already
shipped); lane now adds ONLY E1–E11. Awaiting CI PLAN-SPAR convergence + VTID
allocation before build.
