# VTID-03945 — Extract shared `hidden_breakdown` builder for discover-search/feed

## Context

Rung 5 (highest-complexity) of a 5-rung staged trust-building exercise for
the Operator/autopilot execution plane, executed directly by this Claude
Code session per explicit platform-owner instruction (proxying the task
itself — no `exafy_admin` credentials to invoke the real
`autopilot_execute_task` on-ramp). Deliberately scoped as a genuine
multi-file architectural refactor rather than a single-point fix, per the
5-rung plan's escalating-complexity design (Rung 1: extend a tested
module; Rung 2: build new test infra for an untested module; Rung 3:
frontend bug fix; Rung 4: cross-repo coordinated fix; Rung 5: a refactor
spanning a shared service and two consuming routes).

## Motivation

VTID-03943 (Rung 4) fixed `discover-search.ts`'s `hidden_breakdown`
undercounting bug, and in doing so extracted `excludePastPurchases()` as a
shared helper — but each route still manually re-assembled its own final
`hidden_breakdown` object inline: re-summing `geo` (a pre-filter count over
raw rows, plus `applyUserLimitations()`'s own smaller geo count) and
re-spreading the other seven limitations categories. That is exactly the
"two independently-maintained copies of the same merge logic" shape that
has caused real bugs in this codebase before (VTID-03643, VTID-03644,
VTID-03696, and VTID-03943 itself) — the next person to touch either
route's merge logic could silently reintroduce the same drift.

## Fix

1. `services/limitations-filter.ts`: added two exported types
   (`LimitationsHiddenBreakdown` — the 8 categories `applyUserLimitations()`
   tallies; `HiddenBreakdown` — the full 9-field object a route reports,
   extending the former with `past_purchases`) and one new pure function,
   `buildHiddenBreakdown()`, that merges a pre-filter geo count, an
   optional `LimitationsHiddenBreakdown` (undefined for an anonymous
   discover-search request, since no limitations pass ran), and a past-
   purchases count into the final object — encoding the summing rule
   (`geo = preFilterGeoHidden + limitations.geo`) in exactly one place.
2. `discover-search.ts`: replaced the manual `let hiddenBreakdown = {...}`
   initial literal + conditional reassignment + final past-purchases spread
   (18 lines) with one `buildHiddenBreakdown()` call.
3. `discover-feed.ts`: replaced its inline response-object spread (5 lines)
   with the same call.

Both routes' actual computed output is unchanged — this is a pure
refactor, verified below by reproducing each route's exact pre-refactor
formula in a test and asserting the new function returns identical output.

## Acceptance Criteria

AC-1 — `buildHiddenBreakdown()` sums `preFilterGeoHidden` and
`limitations.geo` correctly, and copies every other limitations category
through unchanged.

TEST: `test/limitations-filter.test.ts` — "sums preFilterGeoHidden and
limitations.geo into the final geo count", "copies every other
limitations category through unchanged", "passes pastPurchasesHidden
straight through".

AC-2 — When `limitations` is `undefined` (the anonymous discover-search
case), every limitations category reports 0 and `geo` is exactly
`preFilterGeoHidden`.

TEST: same file — "reports every limitations category as 0 when
limitations is undefined (anonymous discover-search request)", "reports
every field as 0 for the fully-empty case".

AC-3 — The refactor introduces no behavior change: `buildHiddenBreakdown()`
produces byte-identical output to each route's exact pre-refactor inline
formula, for representative non-trivial inputs.

TEST: same file — "matches discover-search.ts's pre-refactor formula
exactly, ctx-present branch" (reproduces the old
`{...result.hidden_breakdown, geo: hiddenBreakdown.geo +
result.hidden_breakdown.geo, excluded_region: ..., past_purchases: ...}`
literal inline and asserts equality) and "matches discover-feed.ts's
pre-refactor formula exactly" (same approach for feed's formula).

AC-4 — No regression to either route's existing behavior after the
refactor is wired in.

TEST: full gateway regression suite — see Verification below.

## Verification

- `tsc --noEmit`: clean (`outputs/tsc-noemit.txt`).
- New/extended suite: `outputs/jest-new-suite.txt` — 13/13 passing (6
  pre-existing `excludePastPurchases` tests + 7 new `buildHiddenBreakdown`
  tests).
- Full gateway suite (regression check): `outputs/jest-full-suite.txt`.

## What this does NOT do

- Does not change either route's actual filtering logic, query, or
  response shape — only how the final `hidden_breakdown` object already
  in both responses gets assembled internally.
- Does not touch `applyUserLimitations()`'s own per-product filtering loop
  — only how its `hidden_breakdown` output is later merged by callers.
- Does not add a route-level test for `discover-search.ts` — unchanged
  from VTID-03943's reasoning: that file carries this repo's own
  `impact-allow-no-test` annotation, and the refactor is verified via the
  extracted pure function plus formula-equivalence tests instead.

## OASIS impact

OASIS_IMPACT: no — an internal refactor with no schema, API, or event
changes; response bytes for both routes are unchanged.
