# Plan — spotlight-compact-hero

<!-- plan:begin -->
## Goal

Shrink the oversized Spotlight hero on the desktop `dashboard` archetype to a compact
horizontal band (~1/3 of today's hero height) and add a denser bento grid of medium `standard`
cards below it, as a design-contract change applied to **every** `dashboard` screen. Desktop
Spotlight content-area only; sidebar/shortcut bar, top bar, utility tabs, ORB, dark theme and
all mobile layouts unchanged; RTL-safe (logical classes only). Rides the existing
`desktop_spotlight` tenant flag (off by default, previewable with `?spotlight=1`); flipping the
tenant default stays the owner's call.

Repo: `exafyltd/vitana-v1`. All `file:line` below are on vitana-v1 `origin/main` (commit
`847a9f68`), the ref the PLAN-SPAR partner reads via the `spar_refs` companion in `handoff.md`.

## Screens affected (verified)

`archetype: "dashboard"` in `src/design/screen-manifest.json` = `/health`, `/health/vitana-index`,
`/wallet`, `/autopilot`, `/autopilot/audiobook` (all `status: "migrated"`). They are rendered by
four page files:
- `/health` → `src/pages/Health.tsx` (`<ScreenFrame` at :441, `archetype="dashboard"` :442), hero
  `VitanaIndexHeroCard`, no rail.
- `/health/vitana-index` → `src/pages/health/VitanaIndexDetail.tsx` (:649/:650), hero
  `VitanaIndexHeroCard showPillars={false}`, no rail.
- `/wallet` → `src/pages/Wallet.tsx` (:545/:546), inline `<VCard size="spotlight">` hero, no rail.
- `/autopilot` **and** `/autopilot/audiobook` → `src/pages/AutopilotDashboard.tsx` (:483/:484;
  `App.tsx:1545` routes `/autopilot/audiobook` to the same `<AutopilotDashboard />`), hero
  `JourneyHero` (`src/components/spotlight/member/JourneySpotlight.tsx:22`, a `size="spotlight"`
  VCard), and **a rail**: `rail={<JourneyRail …/>}` (`AutopilotDashboard.tsx:508`;
  `JourneyRail` at `JourneySpotlight.tsx:116`, `compact` VCards only).

The task's "Health, Wallet, My Journey, Vitana Index" = `/health`, `/wallet`, `/autopilot` (+ its
audiobook deep link), `/health/vitana-index`.

## Decisions (made here, not left open)

- **D1 — Rail: KEEP where it exists, add none. (Revised in round 1, R1-F1.)** My Journey already
  has a rail (`AutopilotDashboard.tsx:508`): the `JourneyRail` with the autopilot pending-count and
  open-autopilot cards. `dashboard` maps to `stage-rail` (`archetypes.ts:28`), so `SpotlightLayout`
  renders it (`hasRail = width === 'stage-rail' && rail != null`, `SpotlightLayout.tsx:34`) and the
  CSS gives it the second column at a main area ≥ 1060 px (`src/index.css:443-444`) or a toggle sheet
  below that. Keeping it is the cleaner composition: it already follows SR-08 (rails hold only
  `compact`/`row` cards), so it needs no rail change and nothing a member uses today goes away.
  Folding it would remove the toggle sheet and the autopilot-count context for no gain. The three
  rail-less dashboards (Health, Vitana Index, Wallet) stay rail-less. Their "Up Next" content (Health's
  `NextBestActionCard`, Vitana Index's `NextSteps`) goes into the bento grid as a tile. No new rail is
  added anywhere. So: rail kept on My Journey, "Up Next" folded into the grid on the other three.
- **D2 — The compact hero stays the ONE `spotlight` VCard, in a media-less compact presentation.**
  Each dashboard screen must keep exactly one `spotlight` element:
  - SR-06/SR-07 in `docs/design-system/SPOTLIGHT_RULES.md`.
  - The staging design-lint `tests/e2e/staging/design-contract.staging.spec.ts`: for the four
    dominant archetypes it asserts exactly one `[data-vcard-size="spotlight"]` in the first viewport
    ("exactly one spotlight card in the first viewport", the `SINGLE.has(entry.archetype)` block). The
    file exists on `origin/main` next to `tests/e2e/staging/vtid-05111-tier-b.staging.spec.ts`.
    R1-F2 is answered with that path.
  - The Tier B source test `src/pages/spotlight-tier-b.vtid-05111.test.tsx:222-227`. It counts
    `size="spotlight"` plus `<VitanaIndexHeroCard` per migrated dashboard file and accepts **1 to 2**
    (card plus its skeleton), not exactly 1 (R1-F3).

  The `spotlight` VCard already supports a text-only card: with no `media`/`mediaSlot`, `hasMedia` is
  false and no media box renders (`src/components/ui/vcard/VCard.tsx`). The compact band is a
  `spotlight` VCard with no media and a single-row body (small inline Index ring, headline, the
  "+N this week" trend pill, a one-line insight). Its height comes from the content, about 1/3 of
  today's, with no fixed pixel height. All three checks keep counting exactly one spotlight element.
- **D3 — No new size token; existing tokens only.** The band uses the 4px spacing scale and the fixed
  type scale (SR-15/16). The bento uses the existing `TIER_B_GRID` (`TierBKit.tsx:18`, 3 columns from
  `xl`) across the stage column, so a tile is about 31% of the stage (680–760 px, `--sp-stage-max`
  `src/index.css:188`), below the 40% cap (R1). A 2-column dominant grid (about 47%) is not used. A
  full-row tile spans the whole row, never as a wider single tile. **As planned, no new token is
  proposed.** If the band can only reach about 1/3 of today's height with a fixed-height utility
  (forbidden by `design/no-arbitrary-size`, SR-12/14), that would need a new hero-band height token.
  That is a contract addition, so it goes back to the owner rather than being invented.
- **D4 — Grid content comes only from what each page already shows (SR-24/25/26).** The bento tiles
  are each page's existing content cards and existing data. The mock labels (Biomarkers, Sleep,
  Movement, Nutrition…) are not invented: no new KPI and no number the page does not already load. A
  grid row holds `standard` tiles only (SR-11), and SR-13 forbids empty slots. Long-form sections that
  are not cards stay full-width `TierBSection` blocks below the grid, never squeezed into a tile:
  Vitana Index's How-it-works/Mission/agents panels, My Journey's audiobook/catalog section
  `data-testid="desktop-audiobook"`, and Health's `VitanaPillarAgentsPanel`. Every existing control
  and handler stays reachable (SR-26). For Wallet, the hero band keeps the balance, the credits line
  and the two primary actions (Add funds, Send). The other actions (Buy credits, Request, Exchange,
  Withdraw, Spend credits) move into a "Quick actions" `standard` tile with the same handlers and the
  same `isIAPRestricted()` guards.

## Steps (one lane: `compact-hero-grid`; CI allocates its VTID on convergence)

1. **Contract text.** In `docs/design-system/SPOTLIGHT_RULES.md`:
   - Change the `dashboard` row of the §A table: Layout "stage + rail" → "stage (+ optional rail)".
     Dominant element "one hero KPI `spotlight`, then `standard` tiles" → "one COMPACT, media-less hero
     `spotlight` band, then a bento grid of `standard` tiles".
   - Add to §B a dominance clause: on `dashboard` the single `spotlight` card is a compact media-less
     band about 1/3 the height of a full spotlight hero.
   - Add a bento clause: no `dashboard` grid tile is wider than one column of a 3-column grid (about
     40% or less of the stage).
   - SR-06, SR-07, SR-08, SR-11, SR-12 and SR-13 stay verbatim.

   Files: `docs/design-system/SPOTLIGHT_RULES.md`.
   Verify: doc-only; the tests in steps 2–6 prove the behaviour.

2. **Compact hero components.**
   - Add `src/components/spotlight/tier-b/DashboardHeroBand.tsx`: it renders
     `<VCard size="spotlight">` with no `media`, a one-row body (ring/value slot, headline,
     trend-pill slot, one-line insight, actions slot), tokens and logical props only.
   - Add a `compact` prop to `VitanaIndexHeroCard` (`src/components/spotlight/tier-b/VitanaIndexHeroCard.tsx:18`).
     It renders the same media-less one-row band with pillars off.
   - Add a `compact` presentation to `JourneyHero` (`src/components/spotlight/member/JourneySpotlight.tsx:22`)
     on its four `size="spotlight"` branches (loading, error, no goal, goal), with the same media-less
     one-row band.

   Files: `src/components/spotlight/tier-b/DashboardHeroBand.tsx`, `VitanaIndexHeroCard.tsx`,
   `src/components/spotlight/member/JourneySpotlight.tsx`.
   Verify: `npx vitest run src/components/spotlight`. New tests assert that each compact hero renders
   exactly one `[data-vcard-size="spotlight"]` and **no** `[data-vcard-media]`.

3. **Bento grid helper.** In `src/components/spotlight/tier-b/TierBKit.tsx`, add `DASHBOARD_BENTO`,
   which reuses `TIER_B_GRID` (3 columns from `xl`, single-column on narrower stages).
   Files: `src/components/spotlight/tier-b/TierBKit.tsx`.
   Verify: `npx vitest run src/components/spotlight/tier-b`.

4. **Skeleton parity (SR-20/21, CLS < 0.1).**
   - Add a media-less band variant to `VCardSkeleton` (`src/components/ui/vcard/VCardSkeleton.tsx`).
     Today it always renders the 16:9 box for `spotlight`.
   - Switch the `dashboard` case of `ArchetypeSkeleton` (`src/components/layout/spotlight/skeletons/ArchetypeSkeleton.tsx:39`)
     to render the band skeleton plus a 3-column `standard` grid. The desktop path of
     `SpotlightLoading` gets this through `ArchetypeSkeleton`.
   - The mobile `MobileShape` dashboard case (`SpotlightLoading.tsx:59`) is unchanged.
   - The compact heroes' own loading branches use the band skeleton too, so the swap from loading to
     loaded keeps the same height.

   Files: `ArchetypeSkeleton.tsx`, `VCardSkeleton.tsx`.
   Verify: `npx vitest run src/components/layout/spotlight src/components/ui/vcard`.
   `SpotlightLoading.test.tsx` and `spotlight.vtid-05105.test.tsx` are updated to the new desktop
   dashboard shape (band, no media box, 3-column grid). The mobile assertions are unchanged.

5. **Adopt on the four page files** (Spotlight branch only; mobile branches untouched):
   - `src/pages/Health.tsx`: compact `VitanaIndexHeroCard`. `NextBestActionCard` becomes a grid tile.
     The pillar agents panel moves to a full-width section below the grid.
   - `src/pages/health/VitanaIndexDetail.tsx`: compact hero. `NextSteps`, `GoalCard` and `PillarsCard`
     go into the grid. The long-form panels stay full-width below it.
   - `src/pages/Wallet.tsx`: `DashboardHeroBand` with the balance and primary actions, plus a "Quick
     actions" tile with the rest (D4).
   - `src/pages/AutopilotDashboard.tsx`: compact `JourneyHero`. `todaysGoal`, `matchesPreview`,
     `eventsPreview` and `VitanaIndexTrajectoryCard` go into the grid. The audiobook/catalog section
     stays full-width. **`JourneyRail` is kept unchanged** (D1).

   One `spotlight` element per page.
   Verify: `npx eslint` on the four files gives 0 `design/*`. `npx vitest run src/pages/spotlight-tier-b.vtid-05111.test.tsx src/components/spotlight/member`.

6. **Tighten the composition test (R1-F3).** In `src/pages/spotlight-tier-b.vtid-05111.test.tsx`,
   extend the counted patterns with `<DashboardHeroBand`. Keep the 1–2 tolerance and comment it as
   "card + its skeleton". Add a regression assertion that each migrated dashboard file renders a
   compact hero: it passes `compact` to `VitanaIndexHeroCard`, or uses `DashboardHeroBand`.
   Verify: the test is red before step 5 and green after it (record both in the PR).

7. **i18n (only if strings are added).** Add new user-visible strings (for example the "Quick
   actions" tile title) to `src/i18n/de/**` first, then `src/i18n/en/**`. Run
   `npm run i18n:inventory` and commit `docs/SCREEN_INVENTORY.md`.
   Verify: `npm run i18n:inventory` is clean, and the i18n ESLint rules pass in `npm run build`.

8. **Full gate and local screenshots.**
   - Run `npm run build` (tsc and bundle), `npm test`, and `npm run design:manifest` (expect no drift).
   - Then run `npm run preview` with Playwright, signed out with mocked data, at 1400×900 desktop.
     Take before/after shots of `/health`, `/wallet`, `/health/vitana-index` and `/autopilot`, each
     with `?spotlight=1`. Each shot should show the compact band at about 1/3 height, the bento grid,
     and exactly one spotlight element in the first viewport. The `/autopilot` shot also shows the kept
     rail.
   - Take a 390×844 `/health` shot proving the phone layout is unchanged.
   - Save the shots under `docs/validation/<VTID>/`. Do not access any live system.

   Verify: inspect every shot (spacing, alignment, no clipped text, no overflow).

## Enforcement / ratchet (R4)

- New component and skeleton files are `design/*`-clean: tokens, the 4px scale and logical props
  only, with no `h-[…]`/`w-[…]` and no raw palette. New files at 0 keep the Design ratchet at or below
  the base-commit counts.
- `eslint-rules/design/**` is expected to stay **untouched**. The compact-hero rule is enforced by the
  existing one-spotlight checks (D2) and the tightened composition test (step 6). If a lane does edit
  `eslint-rules/design/**`, the same PR commits `scripts/ci/pr-gate/baseline/design.json` equal to
  current counts (the contract-change exception, `SPOTLIGHT_RULES.md` §C).
- No manifest archetype or route change: the five `dashboard` routes keep `archetype: "dashboard"` and
  `status: "migrated"`.
- Staging: no new spec. The existing read-only `design-contract.staging.spec.ts` and
  `vtid-05111-tier-b.staging.spec.ts` (one spotlight, no horizontal scroll, RTL) cover the change.
  They are listed in `docs/validation/<VTID>/staging-tests.json`.

## Out of scope

- Flipping the `desktop_spotlight` tenant default.
- Any change to mobile, chrome, `JourneyRail` or a non-`dashboard` archetype.
- New or changed dashboard data (SR-24).
- Any live-system write.

## Verification summary

- eslint `design/*` = 0 on changed files.
- Design ratchet green vs `origin/main`.
- `npm run build` (tsc).
- `npm test`: manifest, the tightened vtid-05111 composition test, spotlight component tests,
  SpotlightLoading and vtid-05105.
- `npm run design:manifest` shows no drift.
- `npm run i18n:inventory` if strings change.
- LOCAL 1400×900 before/after desktop screenshots plus a 390×844 mobile shot, all signed out or
  mocked, with NO live systems.

The change ships behind `desktop_spotlight` (off by default) and is visible via `?spotlight=1`.
<!-- plan:end -->
