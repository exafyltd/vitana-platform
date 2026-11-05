# Design — Native Wave 2: Home / Feed / News screen ports (native-wave2-home-feed-news-r2)

How the three lanes port the `home-feed` ledger cluster to native. Follows
`docs/programs/native-app/NATIVE-APP-PLAN.md` §3 (architecture) and §4 (parity method), the N3 shell and N2 UI kit
already on main, and `apps/mobile/README.md`. Nothing here changes the program plan or the design contract.

## 1. Where native screens live and how they resolve

Wave 1 N3 (VTID-05186) built the shell and a resolver route: `apps/mobile/app/(app)/[...path].tsx` renders every
ledger destination that is not yet native as "Unported", admin as the web console, unknown as not-found
(`apps/mobile/parity/ledger.json` `native_only` entry for `/*`). Porting a screen means **adding its own Expo Router
file under `apps/mobile/app/`** whose route path equals the web path, so the resolver no longer catches it, the push
`data.url` / universal link / ORB directive resolve the same, and the parity row can go `native`
(`scripts/native/parity-ledger.mjs` `fileToRoute()` maps `app/(app)/foo/[id].tsx` → `/foo/:id`).

Route-file plan (Expo Router, paths = web paths):

| Lane | Native route file(s) under `apps/mobile/app/` | Web path(s) |
|---|---|---|
| `home` | `(app)/home/index.tsx` (tabs `all`/`community` via search param), `(app)/home/compose.tsx`, `(app)/home/comments.tsx`, `(app)/home/notif.tsx` | `/home`, `/home?tab=…`, `/home?compose=1`, `/home/compose`, `/home/comments`, `/home/notif` |
| `news` | `(app)/news/[id].tsx`, `(app)/post/[source]/[id].tsx` | `/news/:id`, `/post/:source/:id` |
| `community-hub` | `(app)/comm/groups/index.tsx`, `(app)/comm/groups/[id].tsx`, `(app)/comm/my-groups/[id].tsx`, `(app)/comm/members.tsx`, `(app)/comm/open-asks.tsx`, `(app)/comm/find-partner.tsx`, `(app)/me/matches.tsx`, `(app)/intents/board.tsx`, `(app)/intents/mine.tsx`, `(app)/intents/match/[id].tsx`, `(app)/search.tsx` | the R0.4 paths |

Query-string variants (`?tab=`, `?view=`, `?compose=1`) are the **same route file** reading the search param, exactly
as the web screen reads `useSearchParams()` — they are distinct ledger rows but not distinct files, so they do not
overlap across lanes. The ledger's shape-matching (`shapeOf`, query dropped) is satisfied by the single file.

## 2. Screen source: the N2/N3 structure, not the web DOM

Each lane re-implements the **mobile web** branch of its source screen with React Native primitives:

- Imports go through ports only: `@vitana/core/*` (hooks, query keys, feed composition, types, registry),
  `@vitana/ui` (UI kit), `@vitana/tokens` (visual values), `src/ports/*` from the shell (`core`, `ui`, `links`,
  `badges`, `soundscape`, `orb-slot`). No `@/…` web import (ESLint-banned in app code).
- The web→native prop map (`apps/mobile/README.md`) is mechanical: `onClick`→`onPress`, `className`→`style`,
  shadcn `Card`→`VCard`/`Panel`, `Dialog`/`Sheet`/`ResponsiveDialog`→the kit's modal / bottom sheet,
  `toast`/`notify*`→`@vitana/ui`/`@vitana/ui/sonner`, list/scroll→`FlatList`/`ScrollView`.
- Mobile patterns already in the shell are reused: `MobileModePill` (Home's `UtilityActionButton` dropdown,
  `src/pages/Home.tsx:24`), the create-post bottom sheet (web `MobileCreatePostSheet`,
  `src/components/profile/mobile/MobileCreatePostSheet.tsx`), header chips (`VitanaIndexChip`, `AutopilotChip`,
  `src/pages/Home.tsx:25`).

### 2a. Home lane specifics (feed composition is the hard part)

Home's feed is composed, not a single list: `composeFeed` + `withHomeNewCards` (`src/lib/feed-compose.ts`), the
ranker (`src/lib/news-feed-ranker.ts`, `FeedItem`/`ArticleFeedItem` types), enrichment cards
(`useEnrichmentCards`), server cards (`pickHomeServerCards`, `getVitanaCardComponent`), and the feed hooks
(`useNewsFeed.ts`, `useAllNewsFeed.ts`). The native Home renders the same composed `FeedItem[]` through a `FlatList`,
mapping each item kind (article → `NewsArticleCard` twin, community post, enrichment card, server card, new-member
card) to a native `VCard`. The compose/rank/hook modules are **pure and class-A candidates** — the lane re-exports
them through `@vitana/core` (manifest line + `core-closure.mjs --write`) rather than re-implementing. The
`FeedItemErrorBoundary` (`src/components/feed/FeedItemErrorBoundary.tsx`, 36 lines) becomes a native error boundary so
one bad card never blanks the feed. Pull-to-refresh, infinite scroll, the three tabs (All / Community via `?tab=`),
compose entry, comments deep-link (`commentsDeepLinkActive`, Home.tsx) and the `/home/notif` "render feed, suppress
front-door overlay" behaviour (`src/App.tsx:992-999`) are all mirrored.

### 2b. News lane specifics

`NewsArticleDetail` is a full-screen reader (`src/pages/NewsArticleDetail.tsx`); `PostDetail` is the single
post/video deep-link target for like & comment notifications (`src/App.tsx:1010`, `src/pages/PostDetail.tsx`). Both
are leaf screens (open from a feed card or a push, back-navigate to it). `<video>`/image handling maps to
`expo-video` / `expo-image` per the program library map (§3). The `NewsArticleCard` web component
(`src/components/crossover/NewsArticleCard.tsx`) has a native twin shared with Home's feed; to avoid a second owner
of that twin, the twin lives in the **`news`** lane's component area and Home imports it through a core/ui port —
recorded in both lanes' logs so there is one owner. (If sparring prefers Home to own it, that is a one-line path move;
default: `news` owns the reader + card twin.)

### 2c. Community-hub lane specifics

Groups list + discover tab, group detail (+ legacy `/comm/my-groups/:id` alias → same screen), members directory
with the profile-preview overlay (`OVERLAY.PROFILE_PREVIEW`), open-asks feed, find-partner with its board/matches/posts
views (`?view=`), the full matches list (`/me/matches`), the three intents screens and global search. Each is a
list/detail/sheet shape covered by the program's per-type functional checklist. Members/find-partner/open-asks must
exclude the test/service allowlists the same way the web does — but these are **ports** that reuse the web hooks, so
the exclusion already lives in `@vitana/core` query logic; the lane adds no new member-listing query (program NEVER
rule 45 is satisfied by reuse, not re-implementation; the lane states this in its PR).

## 3. Disjointness (no overlap, no orphan)

- **Ledger rows:** the 27 `home-feed` rows partition cleanly — `home` 8 (`/home` ×4 incl. overlays + 3 `/home/*`
  routes… counted as HOME.OVERVIEW, HOME.NEWS_ALL, HOME.NEWS_COMMUNITY, HOME.CREATE_POST, LIFE_COMPASS.OVERLAY,
  OVERLAY.MASTER_ACTION, /home/compose, /home/comments, /home/notif), `news` 2 (NEWS.DETAIL, /post/:source/:id),
  `community-hub` 17 (the rest). 8 + 2 + 17 = 27. Each row named explicitly in the lane file.
- **Native files:** each lane owns a disjoint subtree of `apps/mobile/app/` and `apps/mobile/src/screens/` (one
  folder per lane: `src/screens/home/`, `src/screens/news/`, `src/screens/community/`). No file is in two lanes.
- **Tests:** each lane owns `apps/mobile/<its screen test files>` and its `docs/validation/<VTID>/` folder.
- **Shared, by-row-not-by-file:** `apps/mobile/parity/ledger.json` (each lane edits only its own rows),
  `packages/core/manifest.json` + `packages/core/src/**` closure (each lane adds only the re-exports it needs),
  and the DE-first i18n shards (each lane adds only its screens' keys). These are listed in each lane's `paths`.

## 4. Decisions (made by Kiro as planner; sparring may revise)

1. **Three lanes, not one.** The prompt asks for disjoint lanes by cluster (home / feed / news). "Feed" is Home's
   composed feed (it has no separate web page), so the split is `home` (feed lives here), `news` (the readers), and
   `community-hub` (the remaining `home-feed` ledger rows: community, intents, search). Rationale: the three clusters
   touch disjoint route files and components, can be built and reviewed independently, and each leaves the app
   buildable. Reason recorded here per planning-mode rule.
2. **Feed-composition modules move into `@vitana/core`** rather than being re-implemented natively, because they are
   pure and are already the parity method's single source of ranking/compose truth; re-implementing would fork
   behaviour (program §3 extraction model: one module per PR, independent revert).
3. **`news` owns the `NewsArticleCard` native twin**, shared into Home via a port, so the card has exactly one owner
   and the two lanes' `paths` stay disjoint. `home` depends_on `news` for this reason.
4. **No new routes / registry / manifest.** These are ports of screens that already exist in `App.tsx` and
   `screens.json`; adding a native route file is not an `App.tsx` route, so the "new page needs
   screens.json/exclusions.json + screen-manifest + parity rows" rule does not fire — only parity-row **status**
   flips. The lane adds a native route file and a status flip, nothing in `src/navigation/registry/`.
5. **Runtime verification is deferred to G1** (owner gate). Lanes land the ports with offline build + fake-gateway
   unit tests green; the simulator/Maestro/screenshot-parity pass is a `next_actor: owner` task recorded in the lane
   and the staging-tests.json. This matches the program's "fixture / fake-gateway tests only until G1" model
   (`.kiro/specs/health-native` handoff, `native-g1-wiring`).

## 5. Test design (per lane)

- **Unit (jest-expo + RNTL, fake gateway):** each screen renders its loaded state from fixture data, its empty state,
  its error state (and for Home: the composed `FeedItem[]` maps each kind to the right card, the error boundary
  isolates one bad card, the three tabs switch, compose opens the sheet). No network — the gateway/core hooks are
  mocked with fixtures. `src/lib/chatMarkdown`-style pure-module tests for any core module a lane adds.
- **i18n/RTL:** a test asserts no hardcoded user-visible string in the lane's screens and no physical `left`/`right`;
  renders one screen under `ar` (RTL) and asserts start/end classes.
- **Typecheck/bundle/deps:** `npm run typecheck`, `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` from `apps/mobile/`.
- **Parity:** `node scripts/native/parity-ledger.mjs --check` from the repo root (rows `native`, routes present).
- **Deferred (G1, `next_actor: owner`):** Maestro journeys `maestro/<lane>/*.yaml`, iOS simulator + Android emulator
  screenshots at the device sizes, screenshot parity vs the 390×844 read-only staging web screen, listed in
  `docs/validation/<VTID>/staging-tests.json`.

## 6. Open items for the owner / sparring

- G1 isolated test environment (program gate) is required before any device-runtime parity check; until then the
  deferred tasks stay `next_actor: owner`.
- Whether `home` or `news` owns the `NewsArticleCard` twin (decision 3 default: `news`).
- macOS minutes / G3 for iOS-on-device screenshots (program STATUS row 8b) — not needed for the JS build.
