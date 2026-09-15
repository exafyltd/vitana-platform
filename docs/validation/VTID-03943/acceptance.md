# VTID-03943 — discover-search hidden_breakdown undercounts past-purchase exclusions

## Context

Rung 4 of a 5-rung staged trust-building exercise for the Operator/autopilot
execution plane, executed directly by this Claude Code session per explicit
platform-owner instruction (proxying the task itself — no `exafy_admin`
credentials to invoke the real `autopilot_execute_task` on-ramp). This is the
first CROSS-REPO rung: a coordinated backend fix (this repo) plus a frontend
test closing the matching coverage gap (`exafyltd/vitana-v1`), found via a
background research pass across both repos rather than invented.

## Bug

`GET /api/v1/discover/search` (`routes/discover-search.ts`) filters out
products the user already purchased (`withoutPast = allowed.filter(...)`)
but never folded that exclusion count into `hidden_breakdown`/`hidden_total`
— so the "N products hidden, and why" transparency footer silently
undercounted whenever a search result set dropped an already-purchased
product. The sibling route `GET /api/v1/discover/feed`
(`routes/discover-feed.ts`) already did this correctly
(`past_purchases: allowed.length - withoutPast.length`), and the frontend
component that renders this (`HiddenByLimitationsFooter.tsx`,
`exafyltd/vitana-v1`) already recognizes and displays a `past_purchases`
row — it simply never received a non-zero value from Search.

## Fix

1. Extracted the past-purchase exclusion into a new pure, exported helper,
   `excludePastPurchases()` (`services/limitations-filter.ts`) — takes the
   allowed list and the user's past purchases, returns both the filtered
   list and the hidden count in one place, instead of two independently
   maintained inline copies (the exact "two copies drift" shape this
   codebase's own CHANGE LOG has hit before — VTID-03644, VTID-03696).
2. `discover-search.ts`: now calls `excludePastPurchases()` and folds
   `past_purchases_hidden` into `hiddenBreakdown` (previously missing
   entirely — the root bug).
3. `discover-feed.ts`: switched its own already-correct inline computation
   to call the same new shared helper, so the two routes can no longer
   diverge independently.

Net diff: one new pure function + its call sites in two existing routes.
No response shape change for Feed (same field, same values); Search's
`hidden_breakdown.past_purchases`/`hidden_total` now correctly include this
exclusion for the first time.

## Acceptance Criteria

AC-1 — `excludePastPurchases()` correctly filters out only products whose id
matches a past purchase, and reports exactly how many were dropped.

TEST (new file): `test/limitations-filter.test.ts` — 6 unit tests: basic
filtering, correct count with multiple matches, zero when no overlap, zero
when past-purchases list is empty, empty allowed list, and a past-purchase
entry with no matching product contributing nothing.

AC-2 — `discover-search.ts`'s `hidden_breakdown.past_purchases` is now
populated (was previously always absent from the object, since it was
computed but discarded) — verified via `tsc --noEmit` confirming the field
flows through the object's inferred type end to end, and by code inspection
that `hiddenBreakdown` is now seeded with `past_purchases: 0` and updated
via the shared helper on every code path (with-context and without-context).

AC-3 — No regression to `discover-feed.ts`'s existing correct behavior —
verified by the full gateway regression suite passing unchanged.

## Verification

- `tsc --noEmit`: clean (`outputs/tsc-noemit.txt`).
- New suite: `outputs/jest-new-suite.txt` — 6/6 passing.
- Full gateway suite (regression check): `outputs/jest-full-suite.txt` —
  916/917 test suites (1 pre-existing skip), 15,083/15,118 tests passing,
  0 failures.

## What this does NOT do

- Does not add a route-level test for `discover-search.ts` itself — that
  file carries this repo's own documented `impact-allow-no-test` annotation
  ("pure data-access seam... zero coverage today", heavy Supabase
  query-builder chaining). Extracting the fix into a pure, independently
  testable helper is this repo's established alternative to fighting that
  convention with a brittle full-route mock (the same reasoning Rung 2
  applied to `intent-detection-engine.ts`).
- Does not change the response shape for any client — `past_purchases` was
  already an optional field both consumers (`useMarketplace.ts`,
  `HiddenByLimitationsFooter.tsx`) recognized; this only makes Search
  populate it correctly.
- Companion frontend PR (`exafyltd/vitana-v1`): closes the matching
  zero-coverage gap on `HiddenByLimitationsFooter.tsx`'s `past_purchases`
  row, which had no test at all prior to this VTID on either route.

## OASIS impact

OASIS_IMPACT: no — a backend response-field correctness fix, no schema or
event changes.
