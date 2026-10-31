# Tasks: spotlight-compact-hero

This plan has one lane. The contract doc, `archetypes.ts`, the dashboard skeleton, the shared
spotlight/tier-b components and the four dashboard pages are all one surface that depends on itself.
Splitting the work would put two lanes in the same files, which §8a does not allow.
CI PLAN-SPAR allocates the VTID once the plan converges.

<!-- lane: compact-hero-grid -->
## Lane: compact-hero-grid (repo exafyltd/vitana-v1)

The work follows `plan.md` steps 1–8 in order (decisions D1–D7):

1. Change the contract: `SPOTLIGHT_RULES.md` §A dashboard row, the §B dominance rule and the SR-11
   exception, and the §C list of staging specs.
2. Set `ARCHETYPE_WIDTH.dashboard` to `'full'`.
3. Add `DashboardSpotlight`, `DASHBOARD_BENTO` and `QuickActions`, and add the dashboard variants of
   `VitanaIndexHeroCard` and `JourneyHero`.
4. Mirror the bento layout in the `dashboard` skeleton.
5. Use the new layout on Health, Vitana Index, Wallet and My Journey. On My Journey, fold the rail into
   the grid. On Wallet, keep `CurrencyToggle`.
6. Update the tests: add `/autopilot` to the composition test, add the `<JourneyHero` and
   `<DashboardSpotlight` patterns and the bento/no-rail assertion, and test the folded rail's handlers.
7. i18n: DE first, then EN; run `i18n:inventory`.
8. Add the read-only proportion staging spec, run the full local gate, and take screenshots.

Paths (Lane scope):
- `docs/design-system/SPOTLIGHT_RULES.md`
- `eslint-rules/design/**`: only if an enforceable rule changes. In that case also commit a matching
  `design.json`.
- `scripts/ci/pr-gate/baseline/design.json`: only together with the `eslint-rules/design/**` change.
- `src/components/layout/spotlight/archetypes.ts`
- `src/components/layout/spotlight/spotlight.vtid-05105.test.tsx`
- `src/components/layout/spotlight/skeletons/**`
- `src/components/spotlight/tier-b/**`
- `src/components/spotlight/member/JourneySpotlight.tsx`
- `src/components/spotlight/member/*.test.tsx`
- `src/pages/Health.tsx`
- `src/pages/health/VitanaIndexDetail.tsx`
- `src/pages/Wallet.tsx`
- `src/pages/AutopilotDashboard.tsx`
- `src/pages/spotlight-tier-b.vtid-05111.test.tsx`
- `tests/e2e/staging/spotlight-dashboard-proportion.staging.spec.ts`
- `src/i18n/de/**`
- `src/i18n/en/**`
- `docs/SCREEN_INVENTORY.md`
- `docs/validation/<VTID>/**`

Acceptance (the reviewer agent checks these):
- Lint and ratchet:
  - `npx eslint` on every changed file reports 0 `design/*` errors.
  - The Design ratchet is at or below the base-commit counts.
  - If `eslint-rules/design/**` changed, `design.json` equals the current counts.
- Tests and build:
  - `npm test` is green: manifest, vtid-05111 composition (now including `/autopilot`), spotlight
    component tests, `SpotlightLoading.test.tsx` and `spotlight.vtid-05105.test.tsx`.
  - The new tests are recorded red on `origin/main` and green on the PR.
  - `npm run build` (tsc) passes.
  - `npm run design:manifest` shows no drift.
- Each dashboard file has exactly one `<VCard size="spotlight">` element, with gradient-artwork media
  and the accent classes.
- My Journey passes no `rail=`. The folded rail still shows the pending count, and the open-autopilot
  control calls its handler.
- Wallet keeps `CurrencyToggle` and every existing action, either in the card or as quick-action pills.
- The proportion spec passes locally against `npm run preview`:
  - at 1440×900 and 1920×1080, and in RTL;
  - card width is 0.30–0.45 of the stage;
  - card area is ≤ 0.45 of the stage;
  - the card sits at top-start;
  - there is no horizontal scroll and no empty band over 25%.
- Local screenshots, signed out or mocked, are stored under `docs/validation/<VTID>/`:
  - before/after at 1920×1080 and 1400×900 of `/health`, `/wallet`, `/health/vitana-index` and
    `/autopilot`, each with `?spotlight=1`;
  - a 390×844 `/health` shot that shows the phone layout unchanged.
- No new token is added. The optional coloured glow stays flagged and is not shipped.
- No live system is written to.

Staging suite (read-only), listed in `docs/validation/<VTID>/staging-tests.json`:
- `tests/e2e/staging/design-contract.staging.spec.ts`
- `tests/e2e/staging/vtid-05111-tier-b.staging.spec.ts`
- `tests/e2e/staging/spotlight-dashboard-proportion.staging.spec.ts` (new)
