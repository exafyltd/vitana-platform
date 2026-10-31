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
  - docs/validation/**
updated: 2026-10-31T13:40Z
vtid: VTID-05366
---

The 11 E1ΓÇôE11 enrichment moments only, gated through
`eligibleEnrichmentCards(completions, dismissRows, screen, now,
unavailableEnrichmentCards())` ΓÇö completion AND dismissal AND availability.
No F1/F7/F8 and no Index/diary moments ΓÇö those are shipped (VTID-05101) and
retained unchanged. Depends on `companion-enrichment-signals` (needs the
MemberContext fields) and shares `moments.ts` with it (sequenced, ┬º8a).

Contracts:
- R2-F1: pass `unavailableEnrichmentCards()` as the 5th arg; with Meta OAuth
  unset (every current stack) E6/E7 are NOT offered. Test: no E6/E7 moment when
  `INSTAGRAM_CLIENT_ID`/`FACEBOOK_CLIENT_ID` absent, regardless of completion.
- R2-F3: do NOT use `EligibleEnrichmentCard.priority` (1-based, lower=better) as
  the moment priority. Assign each moment an explicit companion-scale priority
  in 20ΓÇô49 (above featureTip 20, below vitanaIndex 50), E1 highest ΓåÆ E11 lowest.
  Priority-pin test asserts absolute values.
- R3-F1: moments read `ctx.eligibleEnrichmentCardTypes` (the pre-computed set
  from the signals lane, built with the tick's real `now`). Moments never call
  `eligibleEnrichmentCards` and never construct a `Date` from `localDate`. Test:
  dismissed E8 at T ΓåÆ null at T+3d, fires at T+8d.
- R3-F2: each moment's `intent` is an English composer instruction (featureTip
  pattern); `ENRICHMENT_CARD_TIPS[Ex].title.en`/`.description.en` go in `facts`
  (`card_title`/`card_description`), never used as the `intent` string.
- R1-F1 (s2): update `test/vtid-05101-companion-generators.test.ts` in this PR
  ΓÇö extend `rich` with `eligibleEnrichmentCardTypes` (all 11), move to the
  17-key set (or split the F-moment pin), relax the intent-prefix regex.
- R1-F2 (s2): set each moment's `topic` per the plan table ΓÇö `null` for
  E1/E2/E4/E5/E8/E9/E10/E11, `'community'` for E3/E6/E7. Test: a community-off
  member gets none of E3/E6/E7.
- R1-F4 (s2): enrichment priority band is **21ΓÇô39** (below `diary_nudge` min 40),
  E1=39 ΓåÆ E11=21. Priority-pin test asserts absolute values incl. a lapsed-diary
  case where `diary_nudge` wins.
- R2-F2 (s2): set `repeatAfterDays` per the ┬º2 table ΓÇö 4 for E1/E2/E4/E5/E11,
  7 for E3/E6/E7/E8/E9/E10. Test: ignored E1 yesterday ΓåÆ not re-offered today.
- R2-F3 (s2): the companion call site passes `unavailableEnrichmentCards()`
  explicitly; test asserts no E6/E7 with Meta env unset.

### 2026-10-22T08:20Z ┬╖ kiro-exafyltd-202610220802-4a74 ┬╖ ready
Rescoped in sparring round-1 rewrite (R1-F1): F1/F7/F8 removed (already
shipped); lane now adds ONLY E1ΓÇôE11. Awaiting CI PLAN-SPAR convergence + VTID
allocation before build.

### 2026-10-28T10:29Z · ci-plan-spar · ready (VTID allocated)
VTID-05366 allocated after policy approval (converged-auto-v1).

### 2026-10-31T13:40Z · kiro-exafyltd-202610220802-4a74 · paths
Added `docs/validation/**` to `paths` before the plan lands on main: the lane PR
must carry `docs/validation/VTID-05366/{staging-tests.json,acceptance.md}`
(CLAUDE.md rule 47 "no suite, no merge"; PR-GATE `change-suite` / `validate-pr`).
Same path every other plan's lanes declare. No other change.
