# Tasks — matches-scroll-end
Authoritative plan: `plan.md` (this folder). VTID: allocated by PLAN-SPAR after approval.

<!-- lane: matches-list-clearance -->
## matches-list-clearance — bottom clearance for the phone Matches list (repo vitana-v1)
Allowed paths (in `exafyltd/vitana-v1`):
- `src/pages/MatchesPage.tsx`
- `src/pages/MatchesPage.bottom-clearance.test.tsx`
- `docs/validation/VTID-*/**`

- [ ] M1. Write `src/pages/MatchesPage.bottom-clearance.test.tsx` first: flag off, 7 matches → 7 rows in
  `matches-list`. The `matches-page` wrapper class contains a `pb-[calc(` value with `--appilix-bottom-nav-height`
  and `safe-area-inset-bottom`, plus `md:pb-6`. Record it red on `origin/main`.
- [ ] M2. `src/pages/MatchesPage.tsx` phone tree: add `data-testid="matches-page"` and the padding from `design.md` to
  the outer wrapper. Nothing else changes.
- [ ] M3. `docs/validation/<VTID>/staging-tests.json` (`kind: existing`, the Vitest suites) and `commands.log`
  (red → green).

Acceptance:
- `npx vitest run src/pages/MatchesPage.bottom-clearance.test.tsx src/pages/vtid-05117-leftovers-2.test.tsx` passes
  on the lane head; the new test fails on `origin/main`.
- `npx tsc --noEmit -p tsconfig.app.json` reports no new error. ESLint on the two source files is clean.
- The diff touches only the allowed paths. No test is weakened. Nothing writes to a live system.
<!-- lane: matches-list-clearance -->
