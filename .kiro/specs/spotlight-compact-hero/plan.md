# Plan — spotlight-compact-hero

<!-- plan:begin -->
## Goal

The single Spotlight card on the desktop `dashboard` archetype is far too big (full stage width and
most of the stage height). The owner approved the "approved blend v2" design (reference mock
`vitana-v1/.agents/tasks/spotlight-card-resize/approved-blend-v2.png`, intent only):

- The Spotlight card **stays a real Spotlight card**:
  - exactly one per screen;
  - it keeps its Spotlight identity: gradient artwork media, accent border, raised elevation, and its
    primary content (Vitana Index ring, headline, "+N this week", one-line insight);
  - only its size changes.
- It sits **top-start of a dense bento grid**, about **40% of the stage width** and **2 grid rows**
  tall. It is never full width and never more than about 45% of the stage area in the first viewport.
- Other medium cards fill the grid around it.
- **Quick actions** are a strip of compact pill buttons, not large tiles.
- The grid **fills a 1920×1080 viewport** with no large empty band at the bottom.

Scope:
- Applies to **every** `dashboard` screen. Desktop Spotlight content area only.
- Unchanged: sidebar/shortcut bar, top bar, utility tabs, ORB, dark theme and every mobile layout.
- RTL-safe: logical classes only, so the card sits top-right in Arabic.
- Ships behind the existing `desktop_spotlight` tenant flag (off by default, previewable with
  `?spotlight=1`). Flipping the default stays the owner's call.

Repo: `exafyltd/vitana-v1`. Every `file:line` is on vitana-v1 `origin/main` `847a9f68`, the ref the
PLAN-SPAR partner reads through `spar_refs` in `handoff.md`.

## Screens affected (verified)

`archetype: "dashboard"` in `src/design/screen-manifest.json` covers `/health`,
`/health/vitana-index`, `/wallet`, `/autopilot` and `/autopilot/audiobook`, all `status: "migrated"`.
They are four page files:

| Route | File | `<ScreenFrame` | Spotlight card | Rail |
|---|---|---|---|---|
| `/health` | `src/pages/Health.tsx` | :441 (`archetype="dashboard"` :442) | `VitanaIndexHeroCard` | none |
| `/health/vitana-index` | `src/pages/health/VitanaIndexDetail.tsx` | :649/:650 | `VitanaIndexHeroCard` | none |
| `/wallet` | `src/pages/Wallet.tsx` | :545/:546 | inline `<VCard size="spotlight">` (:575), with `CurrencyToggle` in its body slot (:581) and seven action buttons | none |
| `/autopilot`, `/autopilot/audiobook` | `src/pages/AutopilotDashboard.tsx` | :483/:484 | `JourneyHero` (`src/components/spotlight/member/JourneySpotlight.tsx:22`, `size="spotlight"`) | `rail={<JourneyRail …/>}` (:508; `JourneyRail` at `JourneySpotlight.tsx:116`) |

`App.tsx:1545` routes `/autopilot/audiobook` to the same `<AutopilotDashboard />` as `/autopilot`.

## Decisions (made here, not left open)

- **D1 — Dashboard stage width: `stage-rail` → `full` (existing token, SR-14).**
  - Today `ARCHETYPE_WIDTH.dashboard = 'stage-rail'` (`archetypes.ts:28`). That caps the stage at
    `--sp-stage-max: 760px` (`src/index.css:188`, `.sp-grid` :426), which leaves most of a 1920 px
    viewport empty and cannot hold a 40%-wide card beside other cards.
  - The approved mock uses the whole content area. `full` (`.sp-layout[data-width="full"]`,
    `src/index.css:436-437`) is an existing contract width, so no new token is needed.
  - This is an archetype contract change: the §A "Layout" column for `dashboard` becomes `full`.
- **D2 — Rail: FOLD into the grid (revised again after the owner's v2 correction).**
  - With width `full`, `SpotlightLayout` draws no rail (`hasRail = width === 'stage-rail' && rail != null`,
    `SpotlightLayout.tsx:34`). The mock also has no rail; its "Up Next" is a grid tile.
  - My Journey's `JourneyRail` content becomes grid tiles: the Autopilot pending-count card with its
    open-autopilot action, and the Index card. It keeps the same props and handlers
    (`pendingCount={autopilotCount}`, `onOpenAutopilot={handleOpenAutopilot}`).
  - My Journey then no longer passes `rail`.
  - R1-F1's second option is implemented with its test: a Vitest asserts My Journey still renders the
    pending count and that the open-autopilot control calls `handleOpenAutopilot` (step 6).
  - Nothing is removed from the member, and the rail toggle sheet goes away only because the content is
    always visible in the grid.
- **D3 — The Spotlight card keeps its identity and its contract size; only its footprint changes.**
  - It stays `<VCard size="spotlight">`, so SR-06/SR-07 and every one-spotlight check are unchanged:
    - `tests/e2e/staging/design-contract.staging.spec.ts`, the `SINGLE.has(entry.archetype)` block
      ("exactly one spotlight card in the first viewport");
    - `tests/e2e/staging/vtid-05111-tier-b.staging.spec.ts`;
    - `src/pages/spotlight-tier-b.vtid-05111.test.tsx:222-227`, which accepts 1–2 for card plus
      skeleton.
  - Media: a gradient-artwork `mediaSlot` in the contract's spotlight ratio, **16:9** (SR-10,
    `VCard.tsx` `aspect-video`). The artwork uses token gradients only, e.g.
    `from-status-success/30 to-status-info/30`, the contract §E Vitana Index ring mapping, or
    `category-*`. The Vitana Index ring and the "+N this week" pill sit on the artwork.
  - Body: eyebrow, headline and the one-line insight.
  - No new media ratio: a wider ratio such as 21:9 would be a contract addition and is not proposed.
  - Accent treatment with existing tokens only: `shadow-vcard-raised` (`tailwind.config.ts:272`),
    `border-primary/50` and `ring-1 ring-primary/30`. This is what sets it apart from the `shadow-vcard`
    standard tiles.
  - **Owner decision flagged, not invented:** a true coloured glow (blurred accent shadow) has no token
    today. Only the neutral `--sp-elevation-1/2` exist (`src/index.css:195-196`). Adding one would be a
    contract addition: a new elevation token, e.g. `--sp-elevation-spotlight`. **The plan ships without
    it**, using the ring/border treatment, and leaves the token to the owner.
- **D4 — Bento geometry with existing grid utilities (no arbitrary sizes, SR-12/14).**
  - The dashboard grid is `grid grid-cols-10 gap-4`, applied at the `xl` breakpoint and up. Below it
    the grid falls back to `TIER_B_GRID` columns, and the card spans the full row only when the grid is
    a single column.
  - The Spotlight card is `col-span-4 row-span-2`: **40% of the stage width, 2 rows**.
  - The cells beside it (6 columns × 2 rows) hold `standard` tiles of `col-span-3`.
  - Following rows hold `standard` tiles of `col-span-2` or `col-span-4`. No standard tile is wider
    than the Spotlight card (`col-span-4` maximum).
  - Every row is a full row of 10 columns (SR-13). `row-span-2` stretches the neighbour tiles to the
    card's height, so there are no holes.
  - First-viewport area: at 1920×1080 the card is about 40% wide × 2 of about 3 visible rows, about
    25–30% of the visible stage area, under the 45% cap.
  - Default Tailwind `grid-cols-10`, `col-span-*` and `row-span-2` are not overridden in
    `tailwind.config.ts`.
  - Contract change: SR-11 ("a grid row never mixes card sizes") gains one `dashboard` exception: the
    single `spotlight` card may share its two rows with `standard` tiles. Every other tile stays
    `standard`.
- **D5 — Tiles come only from data each page already loads (SR-24/25/26).**
  - The mock's numbers are illustrative.
  - Health builds its tiles from `useVitanaIndexCache()` (total, trend and the five pillar scores:
    Sleep, Exercise→"Movement", Nutrition, Hydration, Mental), `useAutopilot()` (pending count and
    latest actions → "Today's plan"), `NextBestActionCard` ("Up Next") and the pillar-agents panel.
  - A tile appears only when a hook already in that page or its existing child components provides the
    data: 7-day trend, biomarkers and lab results.
  - Missing data shows the shared empty state (SR-25) or the tile is left out. The row is then
    rebalanced with `col-span-*` so it stays full, and no number is fabricated.
  - Vitana Index, Wallet and My Journey arrange their existing cards (`NextSteps`, `GoalCard`,
    `PillarsCard`; balance/credits/activity; `todaysGoal`, `matchesPreview`, `eventsPreview`,
    `VitanaIndexTrajectoryCard`, the folded rail cards) the same way.
  - Long-form sections that are not cards stay full-width `TierBSection` blocks after the grid. Examples:
    How-it-works, Mission, the pillar-agents panel on Vitana Index, and My Journey's audiobook/catalog
    section `data-testid="desktop-audiobook"`.
- **D6 — Quick actions = one compact pill strip.**
  - A full-width row after the grid labelled "Quick actions", holding `Button size="sm"
    variant="outline" className="rounded-full"` pills. It is not a VCard and has no empty tile area.
  - Each pill is an existing handler of that page (SR-26):
    - Health: Add data / Health actions → `setHealthActionsOpen`, upload → `setUploadSheetOpen`, lab
      order → `setOrderSheetOpen`.
    - Wallet (R2-F2): the Spotlight card keeps the balance, the credits line, the `CurrencyToggle`
      (body slot, as today) and the two primary actions Add funds and Send. Buy credits, Request,
      Exchange, Withdraw and Spend credits become pills with the same `handleWalletAction(…)` calls and
      the same `isIAPRestricted()` guards.
    - Vitana Index: Log today, Refresh.
    - My Journey: Set goal, Open plan, Open Autopilot.
- **D7 — Viewport fill at 1920×1080.**
  - The grid, the quick-action strip and the long-form sections flow into the remaining height, so
    there is no large empty band under the grid.
  - This is checked by screenshot and by the staging proportion spec (step 8), never by fixed heights.

## Steps (one lane: `compact-hero-grid`; CI allocates its VTID on convergence)

1. **Contract.** Edit `docs/design-system/SPOTLIGHT_RULES.md`:
   - §A `dashboard` row:
     - Layout: "stage + rail" → "`full` bento grid".
     - Dominant element: "one hero KPI `spotlight`, then `standard` tiles" → "one `spotlight` card at
       the grid's top-start, about 40% wide and 2 rows tall, surrounded by `standard` tiles; quick
       actions as a pill strip".
   - §B Dominance:
     - New: on `dashboard` the one `spotlight` card is at most about 40% of the stage width, at most
       about 45% of the first-viewport stage area, never full width, and keeps the Spotlight treatment
       (gradient artwork media, accent border/ring, raised elevation).
     - SR-11: add the dashboard exception (D4).
     - SR-06, SR-07, SR-08, SR-10, SR-12 and SR-13 stay verbatim.
   - §C: list the new staging proportion spec next to `design-contract.staging.spec.ts`.

   Files: `docs/design-system/SPOTLIGHT_RULES.md`.
   Verify: doc only; steps 2–8 prove it.

2. **Archetype width.** Change `ARCHETYPE_WIDTH.dashboard` to `'full'` (`src/components/layout/spotlight/archetypes.ts:28`).
   Files: `archetypes.ts`, plus any test pinning the old value (`src/components/layout/spotlight/spotlight.vtid-05105.test.tsx`).
   Verify: `npx vitest run src/components/layout/spotlight`.

3. **Spotlight card presentation and bento kit.**
   - Add `src/components/spotlight/tier-b/DashboardSpotlight.tsx`. It renders `<VCard size="spotlight">`
     with the token-gradient `mediaSlot` (16:9) carrying a ring/value and a trend-pill slot, the accent
     classes from D3, `col-span-4 row-span-2` at `xl`, and eyebrow, headline, insight, body, actions and
     `data-testid` props.
   - Add `DASHBOARD_BENTO` (D4 grid) and a `QuickActions` pill-strip component to `TierBKit.tsx`
     (`:18` area).
   - Give `VitanaIndexHeroCard` (`VitanaIndexHeroCard.tsx:18`) a `variant="dashboard"` that renders
     through `DashboardSpotlight` (ring on the artwork, pillars off).
   - Give `JourneyHero` (`JourneySpotlight.tsx:22`) the same variant on its four `size="spotlight"`
     branches.

   Files: `src/components/spotlight/tier-b/DashboardSpotlight.tsx`, `TierBKit.tsx`,
   `VitanaIndexHeroCard.tsx`, `src/components/spotlight/member/JourneySpotlight.tsx`.
   Verify: `npx vitest run src/components/spotlight`. New tests: exactly one
   `[data-vcard-size="spotlight"]` with a `[data-vcard-media]` box (artwork present); the accent classes
   are present; the pill strip renders buttons, not VCards.

4. **Skeleton parity (SR-20/21, CLS < 0.1).**
   - Switch the `dashboard` case of `ArchetypeSkeleton` (`skeletons/ArchetypeSkeleton.tsx:39`) to the
     same bento: `grid-cols-10` with `VCardSkeleton size="spotlight"` (which already has the 16:9 box,
     `VCardSkeleton.tsx`) at `col-span-4 row-span-2`, `standard` skeletons in the D4 spans, and a
     pill-strip skeleton row.
   - The mobile `MobileShape` dashboard case (`SpotlightLoading.tsx:59`) is unchanged.

   Files: `ArchetypeSkeleton.tsx`.
   Verify: `npx vitest run src/components/layout/spotlight`. Update `SpotlightLoading.test.tsx` and
   `spotlight.vtid-05105.test.tsx` to the desktop bento shape; the mobile assertions are unchanged.

5. **Adopt on the four page files** (Spotlight branch only, mobile untouched): compose
   `DASHBOARD_BENTO`, then the Spotlight card first, the tiles from D5, `QuickActions` (D6) and the
   long-form sections.
   - `src/pages/Health.tsx`
   - `src/pages/health/VitanaIndexDetail.tsx`
   - `src/pages/Wallet.tsx`: `CurrencyToggle` stays in the card body (R2-F2); the secondary actions
     become pills.
   - `src/pages/AutopilotDashboard.tsx`: the `rail` prop is removed and the `JourneyRail` cards become
     grid tiles (D2).

   One `spotlight` element per page.
   Verify: `npx eslint <the four files>` gives 0 `design/*`.

6. **Tests that pin it (R1-F3, R2-F1).**
   - In `src/pages/spotlight-tier-b.vtid-05111.test.tsx`:
     - add `['/autopilot', 'AutopilotDashboard.tsx']` and `['/autopilot/audiobook', 'AutopilotDashboard.tsx']`
       to `MIGRATED` (:174). If the existing ScreenFrame/`useSpotlightEnabled` source assertions at
       :211-219 do not hold for that file, limit the new rows to the dashboard test only.
     - extend the counted patterns with `<JourneyHero` and `<DashboardSpotlight`, keeping the 1–2
       tolerance commented as "card + its skeleton".
     - add an assertion that every dashboard file composes `DASHBOARD_BENTO` and no longer passes `rail=`.
   - In `src/components/spotlight/member/` tests: My Journey's folded cards render the pending count,
     and the open-autopilot control calls its handler (D2).
   - Run the tests red on `origin/main` and green after step 5; record both in the PR.

   Verify: `npx vitest run src/pages/spotlight-tier-b.vtid-05111.test.tsx src/components/spotlight`.

7. **i18n.** Add new strings ("Quick actions", tile titles) to `src/i18n/de/**` first, then
   `src/i18n/en/**`. Run `npm run i18n:inventory` and commit `docs/SCREEN_INVENTORY.md`.
   Verify: `npm run i18n:inventory` is clean; the i18n ESLint rules pass in `npm run build`.

8. **Proportion spec, full gate and local screenshots.**
   - Add the read-only `tests/e2e/staging/spotlight-dashboard-proportion.staging.spec.ts`. For each
     `dashboard` route with `?spotlight=1`, at 1440×900 and 1920×1080 and once with `dir="rtl"`, it
     checks:
     - exactly one `[data-vcard-size="spotlight"]`;
     - its width / `[data-spotlight-stage]` width ≤ 0.45 and ≥ 0.30;
     - it is not full width;
     - its area / the first-viewport stage area ≤ 0.45;
     - it sits at the inline-start of the first grid row (the right edge in RTL);
     - no horizontal scroll;
     - at 1920×1080 the last grid row's bottom is within the viewport's lower quarter or the page
       scrolls (no empty band greater than 25% of the viewport).

     It is GET/render only and runs behind the existing network write-guard. List it in
     `docs/validation/<VTID>/staging-tests.json`.
   - Locally, run `npm run build`, `npm test` and `npm run design:manifest` (expect no drift).
   - Then run `npm run preview` with the same spec and Playwright pointed at the local preview, signed
     out with mocked data.
   - Take before/after screenshots at 1920×1080 and 1400×900 of `/health`, `/wallet`,
     `/health/vitana-index` and `/autopilot` with `?spotlight=1`, and a 390×844 `/health` shot proving
     phones are unchanged. Save them under `docs/validation/<VTID>/`. Access no live system.

   Verify: the spec passes locally; inspect every shot against the v2 mock.

## Enforcement / ratchet (R4)

- New files are `design/*`-clean: tokens, the 4px scale, default grid utilities and logical props
  only, with no `h-[…]`/`w-[…]` and no raw palette. New files at 0 keep the Design ratchet at or below
  the base-commit counts.
- `eslint-rules/design/**` is expected to stay **untouched**. The new proportion and identity rules are
  enforced by the staging proportion spec and the Vitest assertions, not by a lint rule. If a lane edits
  `eslint-rules/design/**`, the same PR commits `scripts/ci/pr-gate/baseline/design.json` equal to the
  current counts (`SPOTLIGHT_RULES.md` §C).
- Manifest: the five routes stay `archetype: "dashboard"`, `status: "migrated"`. Only the archetype's
  width changes.

## Owner flags

- **New token: none proposed.**
- The optional coloured spotlight glow would need a new elevation token, so the plan ships without it
  (D3). No new size or ratio token.

## Out of scope

- Flipping the `desktop_spotlight` default.
- Mobile, chrome, and non-`dashboard` archetypes.
- New dashboard data (SR-24).
- Any live-system write.

## Verification summary

- eslint `design/*` = 0 on changed files.
- Design ratchet green vs `origin/main`.
- `npm run build` (tsc).
- `npm test`: manifest, vtid-05111 composition (now incl. `/autopilot`), spotlight components,
  SpotlightLoading and vtid-05105.
- `npm run design:manifest` shows no drift.
- `npm run i18n:inventory`.
- The new read-only proportion spec, passing locally against `npm run preview`.
- LOCAL 1920×1080 and 1400×900 before/after desktop shots plus a 390×844 mobile shot, signed out or
  mocked, with NO live systems.
<!-- plan:end -->
