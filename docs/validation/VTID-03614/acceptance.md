# VTID-03614 — Acceptance

**Title:** 36 of 187 nav-catalog screens were unreachable by ORB voice navigation
**Profile:** gateway_backend
**Scope:** `services/gateway/src/lib/nav-catalog-db.ts`, `services/gateway/test/nav-catalog-platform-reach.test.ts`

## Defect

`nav_catalog` holds one row per `(screen_id, platform)`. `getCatalogForTenant()`
scoped to the requested platform with a plain **filter**, and
`effectivePlatform()` (navigator-consult.ts) hard-returns `'mobile'` while
`NAV_PLATFORM_AWARE` is unset — it is unset in production and appears in no
deploy workflow.

Measured on production: 187 distinct screens — 104 on both platforms, 47
mobile-only, **36 desktop-only**. Those 36 were removed from the consult's
search space on every request from every device.

The symptom was not "screen not found". It was the Navigator confidently
offering the wrong neighbours and looping, because the right answer was never
a candidate.

## Acceptance criteria

AC-1 A desktop-only catalog entry is reachable from a mobile consult.
TEST: services/gateway/test/nav-catalog-platform-reach.test.ts — "a desktop-only screen IS reachable from a mobile consult"

AC-2 A mobile-only catalog entry is reachable from a desktop consult (the fix is symmetric).
TEST: services/gateway/test/nav-catalog-platform-reach.test.ts — "a mobile-only screen is reachable from a desktop consult"

AC-3 A screen present on both platforms is returned exactly once, and the row for the REQUESTED platform is the one returned.
TEST: services/gateway/test/nav-catalog-platform-reach.test.ts — "a screen present on both platforms appears exactly once" / "for a duplicated screen the REQUESTED platform row wins"

AC-4 Requested-platform entries lead the list in their original relative order, so nothing that resolves today can be outranked on a tie by a newly-visible cross-platform entry.
TEST: services/gateway/test/nav-catalog-platform-reach.test.ts — "requested-platform entries lead, in their original order"

AC-5 An entry with no `platform` column (the compile-time NAVIGATION_CATALOG shape) still counts as mobile, and is reachable from both platforms.
TEST: services/gateway/test/nav-catalog-platform-reach.test.ts — "an entry with no platform column still counts as mobile"

AC-6 Every screen in the catalog is reachable from every platform; an empty catalog stays empty.
TEST: services/gateway/test/nav-catalog-platform-reach.test.ts — "every screen in the catalog is reachable from every platform" / "an empty catalog stays empty (no crash, no phantom entries)"

AC-7 No regression across the existing navigator/catalog suites.
TEST: services/gateway/test/navigator-consult.test.ts, test/navigation-catalog.test.ts, test/nav-catalog-role.test.ts, test/nav-regression-contract.test.ts — 283 passed, 0 failed (outputs/nav-tests.txt)

AC-8 The new tests actually catch the defect: reverting `selectPlatformEntries()` to the plain filter fails them.
TEST: outputs/mutation-plain-filter.txt — 5 failed, 3 passed under the mutation; the 3 survivors are exactly the properties a plain filter already satisfies.

## Notes

No routes were added or changed, so the Route Mount gate does not apply.
No OASIS event taxonomy is touched.
