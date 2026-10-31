# Tasks — spotlight-compact-hero

The work is one coherent, tightly-coupled change: the contract doc, the shared compact-hero +
bento components, the dashboard skeletons, and the four dashboard pages all depend on the same
shared surface (`src/components/spotlight/tier-b/**`, the `dashboard` skeleton branch, the
contract text and the tests that pin them). Splitting it across lanes would make two lanes edit
the same files (`ArchetypeSkeleton.tsx`, the shared `tier-b` components, `SPOTLIGHT_RULES.md`),
which §8a forbids. So it is a single lane (§8a.6: a small, file-coupled change runs as one
agent). CI PLAN-SPAR allocates the VTID on convergence.

<!-- lane: compact-hero-grid -->
## Lane: compact-hero-grid (repo exafyltd/vitana-v1)

Deliver the compact hero + denser bento grid for the `dashboard` archetype across all five
dashboard routes, as a design-contract change, behind the existing `desktop_spotlight` flag.

Steps:
1. Update `docs/design-system/SPOTLIGHT_RULES.md`: `dashboard` row in the §A archetype table
   and the §B dominance rules (SR-06/SR-07 kept; add the compact-hero presentation clause and
   the bento "no tile > ~40% stage width" clause). No new size token unless flagged in plan.md.
2. Add `src/components/spotlight/tier-b/DashboardHeroBand.tsx` (compact `spotlight` VCard band,
   media-less, one-row body: inline Index ring + headline + "+N this week" + one-line insight).
   Extend `VitanaIndexHeroCard` with a `compact` presentation (no media, pillars off, one row).
3. Add a dashboard bento grid helper in `src/components/spotlight/tier-b/TierBKit.tsx` (reuse
   `TIER_B_GRID`, 3-col at full stage width; no single tile wider than one column).
4. Update the `dashboard` branch of `src/components/layout/spotlight/skeletons/
   ArchetypeSkeleton.tsx` and the desktop path of `SpotlightLoading.tsx` to mirror the compact
   band + 3-col grid; add a media-less band skeleton (in `VCardSkeleton.tsx` or a local
   skeleton) so CLS < 0.1.
5. Adopt the compact band + bento grid in the Spotlight branch of `src/pages/Health.tsx`,
   `src/pages/health/VitanaIndexDetail.tsx`, `src/pages/Wallet.tsx`, `src/pages/
   AutopilotDashboard.tsx`. Each keeps exactly one `spotlight` element. My Journey KEEPS its
   existing `JourneyRail` unchanged (`AutopilotDashboard.tsx:508`); on the three rail-less
   dashboards "Up Next" content becomes a `standard` grid tile. Grid tiles use only content the
   page already loads (no invented KPIs); long-form sections stay full-width below the grid.
   Mobile branches untouched. `JourneyHero` (`JourneySpotlight.tsx:22`) gets the compact
   presentation too.
6. Update the tests that pin the shape: `src/pages/spotlight-tier-b.vtid-05111.test.tsx` (still
   1 spotlight per dashboard), `src/components/spotlight/tier-b/` component tests,
   `src/components/layout/spotlight/skeletons/SpotlightLoading.test.tsx`. Add a focused test
   that the compact band renders no 16:9 media box.
7. i18n: any new user-visible string goes to `src/i18n/de/**` first then `en/**`; run
   `npm run i18n:inventory` and commit `docs/SCREEN_INVENTORY.md` if strings changed.

Paths (Lane scope):
- `docs/design-system/SPOTLIGHT_RULES.md`
- `eslint-rules/design/**` (only if an enforceable rule changes; commit a matching design.json)
- `scripts/ci/pr-gate/baseline/design.json` (only if `eslint-rules/design/**` changes)
- `src/components/spotlight/tier-b/**`
- `src/components/spotlight/member/JourneySpotlight.tsx`
- `src/components/spotlight/member/*.test.tsx`
- `src/components/layout/spotlight/skeletons/**`
- `src/components/ui/vcard/VCardSkeleton.tsx`
- `src/pages/Health.tsx`
- `src/pages/health/VitanaIndexDetail.tsx`
- `src/pages/Wallet.tsx`
- `src/pages/AutopilotDashboard.tsx`
- `src/pages/spotlight-tier-b.vtid-05111.test.tsx`
- `src/i18n/de/**`
- `src/i18n/en/**`
- `docs/SCREEN_INVENTORY.md`
- `docs/validation/<VTID>/**`

Acceptance (the reviewer agent checks these):
- `npx eslint` on every changed file → 0 `design/*` errors (escape-hatch lines only with a
  reason, listed in the PR body); the Design ratchet is ≤ the base-commit counts (green vs
  `origin/main`); if `eslint-rules/design/**` changed, `scripts/ci/pr-gate/baseline/design.json`
  equals current counts.
- `npm test` green: the manifest test, `spotlight-tier-b.vtid-05111.test.tsx` (one spotlight per
  dashboard), the `tier-b` component tests, `SpotlightLoading.test.tsx`, `spotlight.vtid-05105.
  test.tsx`; `npm run build` (tsc) passes.
- `npm run design:manifest` shows no drift (five dashboard routes unchanged, `migrated`).
- Local 1400×900 desktop before/after screenshots (vite build + preview + Playwright,
  signed-out/mocked, no live systems) of `/health`, `/wallet`, `/health/vitana-index`,
  `/autopilot` with `?spotlight=1` showing the compact band ~1/3 height + bento grid and one
  spotlight element in the first viewport; a 390×844 `/health` shot proving the phone layout is
  unchanged. Screenshots attached to the PR under `docs/validation/<VTID>/`.
- No live-system writes anywhere in the change or its verification.

Staging suite: the change is covered by the existing read-only staging design-lint
(`tests/e2e/staging/design-contract.staging.spec.ts`, `vtid-05111-tier-b.staging.spec.ts`) —
exactly one `[data-vcard-size="spotlight"]` per dashboard, no horizontal scroll, RTL. Record
them in `docs/validation/<VTID>/staging-tests.json` (no new write-path spec needed; dashboards
are read-only under `?spotlight=1`).
