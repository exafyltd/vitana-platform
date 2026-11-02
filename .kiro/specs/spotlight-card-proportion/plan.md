---
change_class: standard
---
# plan(spotlight-card-proportion): one Spotlight card at ~40% width beside a 3x2 grid on desktop Spotlight screens
<!-- plan:begin -->
## Goal
Owner, 2026-10-31 (session `kiro-202610152203-0347`), on the four approved mocks: *"very good. yes, this you can
build"*. Earlier in the same review: *"didnt we say we should always have a spotlight card, only the card should not
dominate the screen as before. it should just be in the spotlight"*.

The rule for every desktop Spotlight screen in scope:
1. Exactly one Spotlight card. It keeps its identity: gradient media art, accent glow border, raised elevation, a
   small `SPOTLIGHT` label, and the screen's primary content.
2. It sits top-left at about 40% of the content width and spans 2 grid rows. It is never full width and never more
   than ~45% of the content area at ≥1280 px (up to 50% between 1024 and 1279 px, see D3).
3. To its right, a 3x2 grid of equal `standard` cards.
4. Below, one full-width row of `compact` cards.
5. At 1400x900 and 1920x1080 the grid fills the viewport with no large empty band. Quick actions are pills.
6. Chrome is unchanged: sidebar, `StandardHeader` compact (title card + Autopilot card + Vitana Index card, as in the
   app today, **not** the badges drawn in the mocks), sub-tabs, utility bar, ORB, mobile bottom nav.
7. Phones (<1024 px) are unchanged. Logical properties only (RTL). Design tokens only.
8. Ships behind the existing `desktop_spotlight` flag. Review on staging with `?spotlight=1`. The tenant flag is never
   flipped.

Approved mocks (vitana-v1 `.agents/tasks/spotlight-card-resize/`): `health-proposed.png`, `discover-proposed.png`,
`events-proposed.png`, `find-a-match-proposed.png`. Not approved: `approved-blend*.png`, `option-a.png`,
`option-b.png`.

**Design-contract change (owner-autonomy stop 10):** the owner cleared it for exactly this layout (owner task,
2026-10-31). The contract additions and rewordings are listed under "Contract changes" below. No new size token,
archetype or ESLint rule is added.

Supersedes `spotlight-compact-hero` (platform #4517, closed 2026-10-31; it converged on the rejected
`approved-blend-v2`, with no lanes and no VTIDs) and the layout intent of the closed `desktop-spotlight-finish` lanes
`sizes` and `skeletons` (#4158). Neither is resumed.

## Today (vitana-v1 `origin/main` @ `77ec053163da0f8aa2df3668132aab62c39d5a67`, pinned in `handoff.md` `spar_refs`)
- `src/components/layout/spotlight/ScreenFrame.tsx:58-121`: the chrome renders in this order: SubNavigation (:99),
  `StandardHeader density="compact"` (:101-110), then the utility row + SplitBar (:73-90). It wraps the children in
  `SpotlightLayout width={ARCHETYPE_WIDTH[archetype]}` (:91).
- `archetypes.ts:23-33` sets dashboard = `stage-rail`, storefront and collection = `wide`.
  `SINGLE_SPOTLIGHT_ARCHETYPES` (:36) = focus-feed, storefront, detail, dashboard. It does not include `collection`.
- `src/index.css:186-192` sets `--sp-stage-max: 760px`, `--sp-rail: 340px`, `--sp-gap: 28px`. `.sp-grid` (:419-438)
  caps the stage at 760 px, or at about 1128 px for `wide`. `full` = `minmax(0,1fr)` (:436-438) already exists.
  Content width is about 1096 px at 1400 wide (sidebar 16rem `ui/sidebar.tsx:23`, `px-6`) and about 1616 px at 1920.
  So Health leaves about 336 px empty at 1400 and about 856 px at 1920, and `wide` leaves about 488 px at 1920.
- A child cannot escape the parent `.sp-grid` cap. The width change therefore belongs in `ScreenFrame`, not in pages.
- `VCard.tsx:50-55`: spotlight = `shadow-vcard-raised` + `border`. It has no label and no accent ring.
  `VCardSkeleton.tsx:15` also carries `data-vcard-size="spotlight"`.
- `skeletons/ArchetypeSkeleton.tsx`: storefront = 1 spotlight + 4 standard (:20-30), collection = 8 standard
  (:31-38), dashboard = 1 spotlight + 3 standard (:39-49). `SpotlightLoading.tsx:92` delegates to it on desktop.
  Mobile `MobileShape` is at :45-74.
- Health `src/pages/Health.tsx:436-474`: `ScreenFrame archetype="dashboard"`. `VitanaIndexHeroCard` (:459) is stacked
  above `VitanaPillarAgentsPanel` (:471) and `NextBestActionCard` (:472) in a flex column. Neither of those two is a
  VCard.
- Discover `src/pages/Discover.tsx:156-190` (`storefront`) → `DiscoverStorefront.tsx:165-185`: `ProductHero`
  (`DiscoverCards.tsx:78-119`, side-by-side `grid grid-cols-2`, :116) and then 4-column shelves (`storefront-model.ts:12`
  `DISCOVER_GRID`, `SHELF_SIZE = 4` :15).
- Events `src/pages/community/EventsAndMeetups.tsx:916-959` (`collection`) → `EventsSpotlightBody.tsx`: `events[0]`
  is the spotlight (:72-91, "Details" only), the rest are `row` cards (:95-103), and a nested
  `SpotlightLayout stage-rail` + rail holds Live now / You follow (:41-61, :112).
- Find a Match `src/pages/community/FindPartner.tsx:466-499` (`collection`, route `/comm/find-partner` App.tsx:1283)
  renders **no spotlight card**. `resultsBody` (:303-461) uses `FindPartnerMatchCard`, which is not a VCard, in a
  3-column grid (:371-381).
- Chrome selectors that already exist: `[data-header-density="compact"]` with 2 `button` children
  (`src/components/StandardHeader.tsx:55,64,80`, outside `layout/spotlight/`; imported by `ScreenFrame.tsx:3`;
  pinned by `src/components/StandardHeader.vtid-05105.test.tsx:21`) and `[data-spotlight-utility]` (ScreenFrame.tsx:74).
- Flag: `useSpotlightEnabled.ts:49-63` = `!isMobile && (override ?? tenantFlag)`. `?spotlight=1` writes only
  localStorage (:36-47).

## Design decisions
- **D1 Opt-in, not archetype-wide.** The new layout is a new shared component, `SpotlightGrid`, plus a `ScreenFrame`
  prop `layout="spotlight-grid"`. `ARCHETYPE_WIDTH` and the archetype skeleton defaults are unchanged. Reason: 76
  `collection` and 4 other dashboard/storefront screens (`/autopilot`, `/autopilot/audiobook`, `/health/vitana-index`,
  `/wallet`, `/business`, `/discover/deals-offers`) are outside the approved mocks. Groups must keep 0 spotlight
  (`social-spotlight-pages.vtid-05110.test.tsx:107`). No screen-manifest change, so `npm run design:manifest` is a
  no-op.
- **D2 Width = the existing `full`.** `layout="spotlight-grid"` makes `ScreenFrame` pass `width="full"` to
  `SpotlightLayout`. No new `--sp-*` token and no `index.css` / `tailwind.config.ts` edit, so no native token
  regeneration is needed.
- **D3 Proportion with Tailwind scale classes only.** At `xl` and up: `grid-cols-5`, spotlight `col-span-2 row-span-2`
  (40%), six tiles in the remaining 3 columns x 2 rows. Between `lg` (1024) and `xl` (1280): `grid-cols-4`, spotlight
  `col-span-2 row-span-3` (50%), tiles 2 per row. The ~45% cap is asserted at 1400 and 1920. The 1024 band keeps
  exactly one spotlight in the first viewport (`design-contract.staging.spec.ts:117-144`) with no horizontal scroll.
  The row is `grid-cols-5` (`xl`) / `grid-cols-3` (`lg`) of `compact` cards. Gaps use `gap-4`. Logical properties
  only.
- **D4 Fewer than 6 tiles (SR-13, SR-24).** Tiles are never fabricated. 1-5 tiles: the grid renders what exists in
  reading order, and the spotlight keeps `col-span-2` with its row span reduced to the rows that exist (min 1). 0
  tiles: the shared empty state (SR-25) fills the tile area. The spotlight is never widened. An empty row is not
  rendered.
- **D5 Identity lives in VCard.** A new additive prop `VCard.spotlightLabel?: boolean`, used only with
  `size="spotlight"`, renders the small `SPOTLIGHT` label (`t('spotlight.grid.label')`) and the accent ring
  `ring-1 ring-primary` (theme token). With no media `src`, it renders a token gradient media
  (`bg-gradient-to-br from-primary/30 via-accent/20 to-background`) as the art. The default is off, so existing
  spotlight cards elsewhere are unchanged.
- **D6 All new strings in one namespace and one lane.** Every new key lives in `src/i18n/<locale>/spotlight.json`
  under `spotlight.grid.*` (DE first, du-form, then EN and the other 9 locales). Only `layout-core` touches i18n
  shards, `i18n-source-stamps/*` and `docs/SCREEN_INVENTORY.md`, which keeps the shared-shard hot files in one lane.
  Page lanes reuse these keys and the keys they already have. If a page lane finds that it needs a key not listed
  here, that is a plan deviation for the next sparring round, not an ad-hoc shard edit.
- **D7 Skeleton = same shape.** `ArchetypeSkeleton` and `SpotlightLoading` take `layout="spotlight-grid"` and render
  `SpotlightGrid` with `VCardSkeleton` children (1 spotlight + 6 standard + 5 compact). The default shapes, and the
  mobile `MobileShape`, are untouched. This means no layout shift on the opted-in screens and none elsewhere.
- **D8 Events rail.** Live now / You follow move out of the nested `stage-rail` into a section below the "Upcoming"
  row, as two `compact` rows. No content is dropped. SR-08 stays true because no `standard` card sits in a rail.
- **D9 Find a Match grid only in the `matches` view.** Board, posts and members keep `resultsBody`. A new adapter
  `adapters/match.ts` maps a match to `VCardData`. "Say hello" reuses the existing FindPartner action handler; nothing
  new is written and no new endpoint is added.
- **D10 Health tile content uses real data only.** Sleep, Movement and Nutrition come from
  `useVitanaIndex().pillars`. The 7-day trend comes from `history` / `pillarHistory`. Today's plan comes from
  `useAutopilot().pendingActions`. My Biology is a navigational tile to `/health/my-biology` with copy only (no hook
  exists; `MyBiology.tsx:39,48` query inline). "Up next · For you" uses autopilot actions + next best action as
  `compact`. `VitanaPillarAgentsPanel` / `NextBestActionCard` stay for the flag-off path.

## Interfaces between lanes (fixed here; lanes must not change them)
`src/components/layout/spotlight/SpotlightGrid.tsx`, exported from `layout/spotlight/index.ts`:
```ts
export interface SpotlightGridRow { title: string; seeAllTo?: string; items: ReactNode[] } // compact VCards
export interface SpotlightGridProps {
  label?: string;              // section heading above the grid (already translated)
  seeAllTo?: string;           // optional "See all" link for the grid section
  spotlight: ReactNode;        // exactly one <VCard size="spotlight" spotlightLabel> (or its skeleton)
  tiles: ReactNode[];          // 0..6 <VCard size="standard">; extra items beyond 6 are not rendered
  row?: SpotlightGridRow;      // one full-width row; omitted or empty → not rendered
  empty?: ReactNode;           // shown in the tile area when tiles is empty (shared empty state)
}
```
DOM contract (tests and staging specs read these attributes, never pixels or class strings):
`[data-spotlight-grid]` > `[data-slot="spotlight"]`, `[data-slot="tiles"]`, `[data-slot="row"]`.
`ScreenFrameProps.layout?: 'default' | 'spotlight-grid'`. With `'spotlight-grid'` it sets `width="full"` and
`[data-screen-layout="spotlight-grid"]` on the frame. `ArchetypeSkeleton` / `SpotlightLoading` accept the same
`layout` prop. `VCardProps.spotlightLabel?: boolean`.

i18n keys added by `layout-core` (`spotlight.grid.*`, all 11 locales): `label` (SPOTLIGHT), `seeAll`, `emptyTiles`,
`health.section`, `health.upNext`, `health.viewBreakdown`, `health.askVitana`, `health.biology`, `health.trend`,
`health.todayPlan`, `discover.section`, `discover.browseCategories`, `events.featured`, `events.thisWeek`,
`events.upcoming`, `events.join`, `match.topMatch`, `match.sayHello`, `match.viewProfile`, `match.morePeople`.

## Lanes (all vitana-v1, seat `exafyltd`, executor kiro)
| Lane | Files | Fails on base because |
|---|---|---|
| `layout-core` | `src/components/layout/spotlight/{SpotlightGrid.tsx (new), ScreenFrame.tsx, index.ts, spotlight-grid.test.tsx (new), spotlight.vtid-05105.test.tsx}`, `.../skeletons/{ArchetypeSkeleton.tsx, SpotlightLoading.tsx, SpotlightLoading.test.tsx}`, `src/components/ui/vcard/{VCard.tsx, VCard.test.tsx}`, `src/i18n/*/spotlight.json`, `i18n-source-stamps/*.json`, `docs/SCREEN_INVENTORY.md`, `docs/design-system/SPOTLIGHT_RULES.md`, `docs/validation/<VTID>/**` | `SpotlightGrid` import missing; no `spotlightLabel`; no `layout` prop on frame/skeleton |
| `health` | `src/pages/Health.tsx`, `src/components/spotlight/tier-b/{VitanaIndexHeroCard.tsx, HealthGridTiles.tsx (new), health-grid.test.tsx (new)}`, `src/pages/spotlight-tier-b.vtid-05111.test.tsx`, `tests/e2e/staging/<vtid>-health-spotlight-grid.staging.spec.ts`, `docs/validation/<VTID>/**` | Health renders no `[data-spotlight-grid]`; hero ≈68% of content |
| `discover` | `src/pages/Discover.tsx`, `src/components/discover/spotlight/{DiscoverStorefront.tsx, DiscoverCards.tsx, storefront-model.ts, discover-storefront.vtid-05109.test.tsx}`, `tests/e2e/staging/vtid-05109-discover-storefront.staging.spec.ts`, `tests/e2e/staging/<vtid>-discover-spotlight-grid.staging.spec.ts`, `docs/validation/<VTID>/**` | no grid; picks shelf = 4 standard; hero ≈100% wide |
| `events` | `src/pages/community/EventsAndMeetups.tsx`, `src/components/community/spotlight/{EventsSpotlightBody.tsx, social-spotlight.vtid-05110.test.tsx}`, `tests/e2e/staging/vtid-05110-social-spotlight.staging.spec.ts`, `tests/e2e/staging/<vtid>-events-spotlight-grid.staging.spec.ts`, `docs/validation/<VTID>/**` | rest-of-events are `row`; no grid; no Join |
| `find-a-match` | `src/pages/community/FindPartner.tsx`, `src/components/community/spotlight/{FindMatchSpotlightBody.tsx (new), find-match-spotlight.test.tsx (new)}`, `src/components/ui/vcard/adapters/{match.ts (new), index.ts}`, `src/pages/community/social-spotlight-pages.vtid-05110.test.tsx`, `tests/e2e/staging/<vtid>-find-match-spotlight-grid.staging.spec.ts`, `docs/validation/<VTID>/**` | 0 spotlight cards on `/comm/find-partner` |

`depends_on`: `health`, `discover`, `events` and `find-a-match` each depend on `layout-core` (they import
`SpotlightGrid`, the `ScreenFrame.layout` prop, `VCard.spotlightLabel` and the `spotlight.grid.*` keys). The four page
lanes are independent of each other and run in parallel once `layout-core` is on `main`.

**Parallel / shared / hot files:** no file is in two lanes. `docs/validation/<VTID>/**` is per lane VTID, a
different directory for each lane. Hot files: the i18n shards of namespace `spotlight`, `i18n-source-stamps/*` and
`docs/SCREEN_INVENTORY.md` are only in `layout-core`. No `src/App.tsx`, `screens.json`, `exclusions.json`, parity
ledger, migration, `index.css`, `tailwind.config.ts`, `eslint-rules/design/**`, `scripts/ci/pr-gate/baseline/**`,
`.claude/**`, `.github/**` or `CLAUDE.md` edit. No protected gate file. Landing is serialized (one merge at a time,
each lane updated from `main` first).

## Contract changes (`docs/design-system/SPOTLIGHT_RULES.md`, in `layout-core`, same PR as the component)
- New rule **SR-26 Spotlight grid**: one spotlight card at ~40% of the content width (`xl`+, 50% between `lg` and
  `xl`), spanning 2 rows, top-start; a 3x2 grid of `standard` cards beside it; one full-width `compact` row below. It
  is never full width and never more than ~45% of the content area at ≥1280 px. Opt-in per screen via
  `ScreenFrame layout="spotlight-grid"`, width `full`. It is used by `/health`, `/discover`, `/comm/events-meetups`
  and `/comm/find-partner`.
- §A table: a note on the dashboard, storefront and collection rows that screens opting into SR-26 use it. The
  default layouts are unchanged.
- SR-11: "a grid row never mixes card sizes" is scoped to the SR-26 tile grid and row, with the spotlight cell as the
  one stated exception.
- SR-13: the SR-26 fewer-tiles rule (D4).
- SR-14: `full` is the width for SR-26. No new width token.
- §D desktop line "one dominant card fills the view": becomes "one Spotlight card in the spotlight (SR-26) on
  opted-in screens". Phones are unchanged.
- §F checklist: one item for SR-26.
- `.claude/rules/design.md` is not edited: its lines 17-18 and 24-25 stay true. Not adding a new size token,
  archetype or ESLint rule.

## Tests and commands (each lane, vitana-v1 worktree, Windows)
- Unit: `npx vitest run <lane test paths>`, plus the regression net: `npx vitest run src/components/layout/spotlight
  src/components/ui/vcard src/components/discover/spotlight src/components/community/spotlight src/pages/community
  src/pages/spotlight-tier-b.vtid-05111.test.tsx src/hooks/useSpotlightEnabled.test.ts src/components/profile
  src/components/media/spotlight src/components/tickets src/components/spotlight src/pages/Home.spotlight.vtid-05108.test.tsx
  src/design`.
- `npm run test:design-contract`; `npm run design:manifest` (expect no diff); `npx eslint <changed files>` (design/*
  = 0, new files clean, PR-GATE design ratchet green); `node scripts/ci/pr-gate/gate.mjs weakening --base origin/main
  --head HEAD`; `npm run build`; `npm run i18n:inventory` (`layout-core` only).
- Test weakening: rewritten Discover and Events assertions keep at least the same number of cases and `expect(`
  calls. A retired case is declared in `docs/validation/<VTID>/scope.json` `weakens_tests`, with the reason
  "contract changed on purpose, owner-approved layout 2026-10-31".
- Local visual check per page lane: `npm run build` + `npx vite preview`, then Playwright at 1400x900 `?spotlight=1`
  and 390x844 with route-intercepted GET fixtures (mocked data, signed out, no sign-in that writes). The shot is placed
  side by side with that screen's approved mock in the PR body. Health, Events and Find a Match are behind
  `AuthGuard`, so their local shots use a mocked session in the harness. If the harness cannot render them, the PR
  says so and the staging spec carries the proof.
- Staging (each page lane, read-only via `./staging-guard`, sign-in through Supabase REST as in
  `vtid-05111-tier-b.staging.spec.ts:19`, `kind: playwright` in `docs/validation/<VTID>/staging-tests.json`). At
  1400x900 `?spotlight=1`, after `[data-archetype-skeleton]` is gone:
  - exactly 1 `[data-spotlight-grid] [data-vcard-size="spotlight"]:not([data-vcard-skeleton])`, with its width
    ≤ 0.45 and ≥ 0.30 of `[data-spotlight-layout]` width;
  - the `[data-slot="tiles"]` cards sit beside it (top within the spotlight's vertical span);
  - `[data-slot="row"]` top ≥ spotlight bottom when the row is rendered;
  - `[data-header-density="compact"]` is visible with 2 `button` children, and `[data-spotlight-utility]` is visible;
  - no horizontal scroll.
  At 390x844 with no query: 0 `[data-spotlight-layout]` and 0 `[data-archetype]`, and `.mobile-bottom-nav` is
  visible. Thin test-account data only changes counts inside the slots, never the width or one-spotlight assertions.
- `layout-core` staging suite: `kind: existing`, `npx vitest run src/components/layout/spotlight
  src/components/ui/vcard`. Not verified on staging: the layout is opt-in and no screen uses it until a page lane
  lands. The page lanes' specs carry the visible proof.
- Deploy path: a merge to `main` touching `src/**` → `AWS-STAGE-DEPLOY-FRONTEND.yml` → `preview-aws.vitanaland.com` →
  platform `STAGING-VERIFY.yml` (community-app smoke + each lane's suite). The end point is STAGING-VERIFY green on the
  last lane's merge commit.

## Measurement
`docs/validation/<plan VTID>/timings.json` (`vitana.plan-timings/v1`), written by the closing step. Gate 2 quotes it.

## Risks
1. Other dashboard/storefront/collection screens regress → D1 opt-in. `design-contract.staging.spec.ts` (1024/1440/1920)
   and `social-spotlight-pages.vtid-05110.test.tsx:107` (Groups = 0 spotlight) stay green unchanged.
2. Tests that pin the old Discover/Events shape → rewrite with equal or more cases and expects (`lib.mjs:184-199`), or
   declare `weakens_tests`.
3. 1024-1279 px band → D3 fallback, tested in `spotlight-grid.test.tsx` by class contract and at 1024 by the existing
   design-contract staging spec.
4. `VitanaIndexHeroCard` (also used by `VitanaIndexDetail.tsx:650`) and `ProductHero` (Discover results mode) are
   shared → only additive props. Their existing call sites render as before.
5. Skeleton false positive (`VCardSkeleton.tsx:15`) → the staging selector excludes `[data-vcard-skeleton]` and waits
   for the skeleton to clear.
6. Staging data thin for the test account → structural assertions; empty states covered in Vitest (D4).
7. `docs/SCREEN_INVENTORY.md` / stamps freshness checks on page lanes → page lanes add no strings (D6). If a check
   still flags them, the lane records it in `blockers.md` and regenerates only after updating from `main` at its
   serialized landing.
8. "Say hello" near-overlap with open v1 #1520 (`NewMemberGreetingComposer`, `communityHubNative`) → not reused;
   Find a Match uses its own existing handler and `spotlight.grid.match.sayHello`.

## Unchanged
Chrome (`StandardHeader.tsx`, SubNavigation, `UtilityActionButton`, `AppLayout`, sidebar, ORB, `MobileBottomNav`);
all phone paths; `ARCHETYPE_WIDTH`; the default archetype skeletons; the screen manifest; the `desktop_spotlight`
tenant flag; routes and the navigation registry; ESLint design rules and baselines; every screen that does not opt in.
<!-- plan:end -->
