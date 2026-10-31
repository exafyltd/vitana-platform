# Tasks — spotlight-card-proportion
Authoritative plan: `plan.md` (interfaces, decisions D1-D10, contract changes). VTIDs: allocated by PLAN-SPAR.
All lanes are in `exafyltd/vitana-v1`. `layout-core` lands first; the four page lanes then run in parallel.

<!-- lane: layout-core -->
## layout-core — shared SpotlightGrid, frame opt-in, VCard identity, skeletons, contract text, i18n keys
- [ ] L1. `src/components/layout/spotlight/SpotlightGrid.tsx` (new) with the exact props and DOM contract of plan.md
  "Interfaces". Grid: `xl:grid-cols-5` with spotlight `xl:col-span-2 xl:row-span-2`; `lg` `grid-cols-4` with
  spotlight `col-span-2 row-span-3`. Tiles go 3x2 beside it, and the row goes below (D3). Includes the D4 fewer-tiles
  and empty rules. Export it from `index.ts`.
- [ ] L2. `ScreenFrame.tsx`: `layout?: 'default' | 'spotlight-grid'`. `'spotlight-grid'` → `SpotlightLayout
  width="full"` and `data-screen-layout="spotlight-grid"`. Chrome (:73-117) unchanged. Default behaviour is
  byte-identical.
- [ ] L3. `VCard.tsx`: additive `spotlightLabel?: boolean` (only for `size="spotlight"`): the small label
  `t('spotlight.grid.label')`, `ring-1 ring-primary`, and token-gradient media when `src` is null (D5).
- [ ] L4. `skeletons/ArchetypeSkeleton.tsx` + `SpotlightLoading.tsx`: `layout="spotlight-grid"` renders
  `SpotlightGrid` with `VCardSkeleton` (1 spotlight + 6 standard + 5 compact). Defaults and `MobileShape` are
  untouched (D7).
- [ ] L5. i18n: every `spotlight.grid.*` key of plan.md in `src/i18n/de/spotlight.json` first (du-form), then `en` and
  the other 9 locales. Regenerate `i18n-source-stamps/*` the way the repo does (`scripts/i18n-stamp-source.mjs` /
  I18N-PROPAGATE). Run `npm run i18n:inventory` and commit `docs/SCREEN_INVENTORY.md`.
- [ ] L6. `docs/design-system/SPOTLIGHT_RULES.md`: SR-26 plus the SR-11 / SR-13 / SR-14 / §A / §D / §F edits of
  plan.md "Contract changes". Record the owner approval of 2026-10-31.
- [ ] L7. Tests: new `spotlight-grid.test.tsx` covering:
  - 1 spotlight in `[data-slot=spotlight]`, 6 standard in `tiles`, compact only in `row`;
  - more than 6 tiles truncated;
  - 3 tiles → 3 rendered, spotlight still `col-span-2`;
  - 0 tiles → `empty` rendered and the spotlight not widened;
  - no physical-direction classes.

  Extend `spotlight.vtid-05105.test.tsx`: `ScreenFrame layout="spotlight-grid"` → `data-width="full"`; the default
  is unchanged; the grid skeleton shape. Extend `SpotlightLoading.test.tsx`: desktop grid shape; mobile expectations
  unchanged. Extend `VCard.test.tsx`: label + ring only with `spotlightLabel` on `spotlight`.
- [ ] L8. `docs/validation/<VTID>/staging-tests.json` (`kind: existing`, `npx vitest run
  src/components/layout/spotlight src/components/ui/vcard`), `acceptance.md`, `commands.log`, `scope.json`.

Acceptance:
- Change types: UI, Tooling/docs
- Outcome: no screen changes yet. Pages can opt into a one-Spotlight-at-40% grid; the Spotlight card can carry its
  label and accent ring; the loading shape matches the grid.
- States: loading (grid skeleton, same box sizes), empty (0 tiles → shared empty state; row hidden when empty), fewer
  tiles (D4), long titles (VCard truncation unchanged).
- Surfaces: desktop only (≥1024 via `ScreenFrame`). Phones never render `ScreenFrame`/`SpotlightGrid` (`useSpotlightEnabled`).
  No existing screen passes `layout`, so every current screen renders byte-identically.
- Locales: DE first, du-form; all 11 locales have every `spotlight.grid.*` key. Arabic: logical classes only (test
  asserts no `ml-/mr-/pl-/pr-/left-/right-`).
- Accessibility: the label is text (not color only), the ring keeps AA contrast (theme token), and section headings
  are real headings in reading order.
- Contract: the `SpotlightGrid` props/DOM, `ScreenFrame.layout`, `VCard.spotlightLabel` and the skeleton `layout`
  exactly as in plan.md "Interfaces".
- Staging proof: not verified on staging: the layout is opt-in and unused until a page lane lands. Covered by
  `spotlight-grid.test.tsx` and the extended layout/skeleton/VCard tests. The page lanes' specs carry the visible
  proof.
- `npm run test:design-contract`, `npm run build` and `npm run design:manifest` (no diff) are green. design/* is 0 on
  every touched file. No test weakened. `ARCHETYPE_WIDTH` and the default skeletons are unchanged.
- SPOTLIGHT_RULES.md has SR-26 and the listed rewordings, no new token, archetype or ESLint rule, and
  `.claude/rules/design.md` is untouched.
<!-- lane: layout-core -->

<!-- lane: health -->
## health — `/health` onto SpotlightGrid (depends on layout-core)
- [ ] H1. `Health.tsx` Spotlight branch (:436-474): `ScreenFrame layout="spotlight-grid"`. Spotlight =
  `VitanaIndexHeroCard` with `spotlightLabel`, the ring, five pillar bars, headline and insight, and View breakdown
  (opens the Index sheet, :462) / Ask Vitana.
- [ ] H2. `VitanaIndexHeroCard.tsx`: additive props only (ring media, actions); the `VitanaIndexDetail.tsx:650` call
  site renders as before.
- [ ] H3. `HealthGridTiles.tsx` (new): six `standard` VCards — Sleep, Movement, Nutrition (pillars), My Biology (nav
  to `/health/my-biology`, copy only), 7-day trend (`history`), Today's plan (`useAutopilot().pendingActions`). Row
  "Up next · For you" = compact cards from autopilot actions + next best action (D10). Real data only; absent data →
  D4.
- [ ] H4. Tests: new `health-grid.test.tsx` (mocked hooks: one spotlight, 6 tiles in order, row, empty pillars → no
  fabricated values). Extend `spotlight-tier-b.vtid-05111.test.tsx` (Health composes `SpotlightGrid`; the 1-2
  spotlight-size source count stays).
- [ ] H5. Staging spec `tests/e2e/staging/<vtid>-health-spotlight-grid.staging.spec.ts` + `docs/validation/<VTID>/`
  manifest, with the assertions of plan.md "Tests and commands" for `/health`. Local shots at 1400x900 `?spotlight=1`
  and 390x844, next to `health-proposed.png`.

Acceptance:
- Change types: UI
- Outcome: at 1400x900 with Spotlight on, the member sees the Vitana Index Spotlight card at ~40% top-start, six
  health cards beside it and "Up next · For you" below, with no empty band. The header still shows the title,
  Autopilot and Vitana Index cards.
- States: loading (grid skeleton), no index yet / empty pillars (honest empty tiles, no invented numbers), no
  autopilot actions (row hidden), error (existing Health error handling).
- Surfaces: `/health` desktop Spotlight branch. Flag-off desktop and phones are unchanged
  (`VitanaPillarAgentsPanel`, `NextBestActionCard` remain there). `/health/vitana-index` is unchanged.
- Locales: only existing keys and `spotlight.grid.*`; numbers and dates via `@/lib/locale-format`; ar screenshot
  mirrors.
- Accessibility: every tile is a link or button with an accessible name; keyboard order is spotlight → tiles → row;
  focus is visible.
- Contract: uses the `SpotlightGrid` / `ScreenFrame.layout` / `VCard.spotlightLabel` interfaces unchanged; no new
  endpoint.
- Staging proof: the spec asserts 1 spotlight ≤45% and ≥30% of the layout width, tiles beside it, the row below,
  header compact with 2 buttons, the utility bar, no horizontal scroll; at 390x844 no Spotlight frame and the mobile
  nav is visible.
- The new tests fail on `origin/main` (no `[data-spotlight-grid]`) and pass on the head. design/* = 0. Build green.
<!-- lane: health -->

<!-- lane: discover -->
## discover — `/discover` onto SpotlightGrid (depends on layout-core)
- [ ] D1. `Discover.tsx:156-190` passes `layout="spotlight-grid"` to the overview `ScreenFrame` only. Results mode
  (:128-161) keeps its own hero.
- [ ] D2. `DiscoverStorefront.tsx`: spotlight = top recommended product (`ProductHero` stacked variant, with
  `spotlightLabel`); tiles = `feedItems.slice(1, 7)` as `ProductVCard`; row "Browse categories" = compact links to
  the existing routes (`/discover/supplements`, `/discover/wellness-services`, `/discover/doctors-coaches`,
  `/discover/deals-offers`, `/discover/marketplace`). The existing shelves stay below the grid.
- [ ] D3. `DiscoverCards.tsx`: additive stacked `ProductHero` variant (the default side-by-side variant stays for
  results mode). `storefront-model.ts`: `GRID_TILES = 6`.
- [ ] D4. Tests: rewrite `discover-storefront.vtid-05109.test.tsx` (:131-147, 211-213, 265, 293) for the new shape
  with equal or more cases and expects. Results mode still has exactly one spotlight (:306, :316). Update
  `vtid-05109-discover-storefront.staging.spec.ts:65-69` to the new structure (contract changed on purpose; say so in
  the PR).
- [ ] D5. Staging spec `<vtid>-discover-spotlight-grid.staging.spec.ts` + manifest for `/discover` (plan.md
  assertions). Local shots next to `discover-proposed.png`.

Acceptance:
- Change types: UI
- Outcome: Discover shows the top recommendation as the one Spotlight card at ~40%, six products beside it and
  "Browse categories" below, with shelves underneath.
- States: loading (grid skeleton), fewer than 7 feed items (D4, no placeholders), empty feed (shared empty state),
  guest (allowed).
- Surfaces: `/discover` overview desktop Spotlight. Results mode, `/discover/deals-offers`, `/business`, flag off
  and phones are unchanged.
- Locales: `spotlight.grid.discover.*` + existing `spotlightDiscover` keys; prices via locale-format; ar mirrors.
- Accessibility: product cards and category links have names; keyboard order follows the reading order.
- Contract: interfaces of plan.md unchanged; the same feed source; no new endpoint.
- Staging proof: the `/discover` spec with the plan assertions; the updated vtid-05109 spec stays green on staging.
- No weakening (or a declared `weakens_tests`). design/* = 0. Build green.
<!-- lane: discover -->

<!-- lane: events -->
## events — Community > Events & MeetUps onto SpotlightGrid (depends on layout-core)
- [ ] E1. `EventsAndMeetups.tsx:916-959`: `ScreenFrame layout="spotlight-grid"` for the Spotlight body.
- [ ] E2. `EventsSpotlightBody.tsx`:
  - spotlight = `events[0]` with `spotlightLabel`, Details, and Join (`spotlight.grid.events.join`, which uses the
    existing join/RSVP handler of the page; no new write path);
  - tiles = this week's events = `more.slice(0, 6)` as `standard`;
  - row "Upcoming" = the rest as `compact`;
  - Live now / You follow move from the nested rail to a section below as compact rows (D8).
- [ ] E3. Tests: rewrite `social-spotlight.vtid-05110.test.tsx:122-154` (one spotlight + Join, 6 standard, compact
  row, click handlers work, the Live now / You follow section). Equal or more cases and expects, or a declared
  `weakens_tests` for the rail case. Update `vtid-05110-social-spotlight.staging.spec.ts:77-84` to the new structure
  (contract changed on purpose).
- [ ] E4. Staging spec `<vtid>-events-spotlight-grid.staging.spec.ts` + manifest for `/comm/events-meetups`. Local
  shots next to `events-proposed.png`.

Acceptance:
- Change types: UI
- Outcome: the next big event is the one Spotlight card at ~40% with Join, this week's events sit 3x2 beside it, and
  "Upcoming" is below. Live now / You follow are still reachable below.
- States: loading (grid skeleton), 0 events (shared empty state, no rail), 1-6 events (D4), long titles.
- Surfaces: `/comm/events-meetups` desktop Spotlight. Groups, Members, other collection screens, flag off and phones
  are unchanged (`social-spotlight-pages.vtid-05110.test.tsx:107` stays green).
- Locales: `spotlight.grid.events.*` + existing `spotlightSocial` keys; dates via locale-format; ar mirrors.
- Accessibility: Join and Details are named buttons; keyboard order follows the reading order.
- Contract: Join calls the page's existing handler (`file:line` in the PR); no new endpoint.
- Staging proof: the `/comm/events-meetups` spec with the plan assertions (read-only, Join never clicked).
- No weakening (or a declared `weakens_tests`). design/* = 0. Build green.
<!-- lane: events -->

<!-- lane: find-a-match -->
## find-a-match — Community > Find a Match onto SpotlightGrid (depends on layout-core)
- [ ] F1. `adapters/match.ts` (new) maps a match to `VCardData`, following `adapters/member.ts` / `event.ts`. Export it
  from `adapters/index.ts`.
- [ ] F2. `FindMatchSpotlightBody.tsx` (new): spotlight = `matches[0]` (top match, match %, shared goals, Say hello +
  View profile, `spotlightLabel`); tiles = `matches.slice(1, 7)`; row "More people with your goals" = `suggestions`
  (or the leftover matches) as `compact`. Say hello / View profile use the existing FindPartner handlers.
- [ ] F3. `FindPartner.tsx:466-499`: in the `matches` view only, `ScreenFrame layout="spotlight-grid"` with
  `FindMatchSpotlightBody`. Board, posts and members keep `resultsBody`. Mobile branches untouched.
- [ ] F4. Tests: new `find-match-spotlight.test.tsx` (1 spotlight, 6 standard, row, 0 matches → empty state, handlers
  called). Extend `social-spotlight-pages.vtid-05110.test.tsx` with a FindPartner flag-on case (1 spotlight) and a
  flag-off case (no VCards). The Groups = 0 spotlight case stays unchanged.
- [ ] F5. Staging spec `<vtid>-find-match-spotlight-grid.staging.spec.ts` + manifest for `/comm/find-partner`, with
  `allowAbortedWrites` covering `daily_matches` / `generate-daily-matches` as in
  `design-contract.staging.spec.ts:23-26`. Local shots next to `find-a-match-proposed.png`.

Acceptance:
- Change types: UI
- Outcome: Find a Match shows the top match as the one Spotlight card at ~40% with Say hello, six match cards beside
  it and "More people with your goals" below.
- States: loading (grid skeleton), no matches (shared empty state), 1-6 matches (D4), long names.
- Surfaces: `/comm/find-partner` matches view on desktop Spotlight. Board, posts, members, flag off and phones are
  unchanged.
- Locales: `spotlight.grid.match.*` + existing `screens.community.*` keys; ar mirrors.
- Accessibility: Say hello and View profile are named buttons; avatars have alt text from the name.
- Contract: Say hello calls the existing FindPartner handler (`file:line` in the PR); no new endpoint; no write
  during staging tests (Say hello never clicked).
- Staging proof: the `/comm/find-partner` spec with the plan assertions.
- New tests fail on base (0 spotlight). design/* = 0. Build green.
<!-- lane: find-a-match -->
