# Plan — native-wave2-home-feed-news
Author: Kiro, seat `exafyltd`. Repo: `exafyltd/vitana-v1` (native app only — `apps/mobile/**`, `packages/core/**`
via the manifest/closure process, `apps/mobile/parity/ledger.json`, DE-first i18n shards, `docs/validation/**`; no
backend, no gateway change, no migration). Spec: `requirements.md`, `design.md`, `tasks.md`, `lanes/*.md` in this
folder. Program: `docs/programs/native-app/NATIVE-APP-PLAN.md` (VTID-05021), §5 Wave 2.

<!-- plan:begin -->
## Goal
First Wave 2 screen-port batch of the native Maxina app: port the home / feed / news cluster — the 27 web
destinations the parity ledger assigns to `"lane": "home-feed"` — to the native app (`apps/mobile/`) at 1:1 parity
with today's **mobile web** screens, built on `@vitana/core` + `@vitana/tokens` + the N2 UI kit (`@vitana/ui`) on the
Wave 1 N3 shell, with fixture / fake-gateway unit tests. Does **not** need G1 planned or built to land the ports;
every device-runtime verification step is marked depends-on-owner (G1). No redesign (program §4), no new web screen,
no `App.tsx` route, no registry/manifest change — only native route files and parity-row status flips.

## Measured state (worktree = origin/main, parity ledger `apps/mobile/parity/ledger.json` version 2)
- **27 rows** carry `"lane": "home-feed"`, **all `status: "not_started"`** (19 `screen`, 3 `overlay`, 5 `route`);
  **435 rows total**. Counted with `node -e` over the committed ledger (the `--report` CLI needs `typescript`, not
  installed in this worktree). The 27 rows and their web paths are listed in `requirements.md` R0.2–R0.4.
- Web sources verified present with line counts: `src/pages/Home.tsx` (970), `NewsArticleDetail.tsx` (230),
  `PostDetail.tsx` (158), `Search.tsx` (492), `MatchesPage.tsx` (183), `IntentBoard.tsx` (225), `MyIntents.tsx` (202),
  `IntentMatchDetail.tsx` (192), `community/Groups.tsx` (272), `community/GroupDetail.tsx` (234),
  `community/Members.tsx` (332), `community/OpenAsks.tsx` (289), `community/FindPartner.tsx` (780); feed modules
  `lib/feed-compose.ts` (98), `lib/news-feed-ranker.ts` (351), `hooks/useNewsFeed.ts` (306),
  `hooks/useAllNewsFeed.ts` (676); card twin `components/crossover/NewsArticleCard.tsx` (187); routes at
  `src/App.tsx:946-1016` (home/news/post), `:1226-1287` (groups/members/open-asks/find-partner),
  `:1488-1526` (search/matches/intents).
- Wave 1 is on main: N3 shell + resolver route (`apps/mobile/app/(app)/[...path].tsx`, VTID-05186), N2 UI kit
  (`@vitana/ui`, VTID-05176), N1 `@vitana/core`/`@vitana/tokens` (VTID-05183). Prop map, ports and conventions in
  `apps/mobile/README.md`. The native app has no production profile; `assertNotProduction()` refuses prod/staging hosts.

## Decisions (made by Kiro as planner under the owner's "finish the native apps" instruction; sparring may revise)
1. **Three disjoint lanes by cluster** (prompt: home / feed / news). "Feed" is Home's composed feed (no separate web
   page), so: **`home`** (feed lives here), **`news`** (the `/news/:id` + `/post/:source/:id` readers), **`community-hub`**
   (the remaining `home-feed` ledger rows — community, intents, search). The three touch disjoint route files and
   component folders, build/review independently, each leaves the app buildable. Partition: home 8 rows, news 2 rows,
   community-hub 17 rows = 27 (design §3).
2. **Feed-composition / ranking / feed-hook modules move into `@vitana/core`** (one re-export line per module +
   `core-closure.mjs --write`) rather than re-implemented, because they are pure and are the parity method's single
   source of compose/rank truth (program §3 extraction: one module per PR, independent revert).
3. **`news` owns the `NewsArticleCard` native twin**, shared into Home via a port, so the card has one owner and the
   two lanes' `paths` stay disjoint. Therefore **`home` depends_on `news`**; `news` and `community-hub` have no deps
   and run in parallel.
4. **No new routes / registry / manifest.** Ports of screens already in `App.tsx` + `screens.json`; a native Expo
   Router file is not an `App.tsx` route, so the "new page needs screens.json/exclusions.json + screen-manifest +
   parity rows" rule does not fire — only parity-row **status** flips (`not_started`→`in_progress`→`native`).
5. **Device-runtime verification deferred to G1** (owner gate). Lanes land with offline build + fake-gateway unit
   tests green; the Maestro / simulator / screenshot-parity pass is a `next_actor: owner` task recorded in the lane and
   `staging-tests.json`. Matches the program's "fixture / fake-gateway tests only until G1" model.
6. **Mobile-web parity, not desktop.** Each native screen mirrors the `useIsMobile()` ≤ 1024 px branch of its source
   (program §1 shell), composed through N3/N2, every visual value from `@vitana/tokens`; the four N2-documented web
   defects are not reproduced and no web file is touched beyond a DE-first i18n key and a `@vitana/core` re-export line.

## Lanes (all `ready`, executor kiro; seat → reviewer_seat; `vtid:` filled by CI on convergence)
| Lane | Seat → reviewer | Scope (web destinations) | depends_on |
|---|---|---|---|
| `news` | exafyltd → hotmail | `NEWS.DETAIL /news/:id`, `/post/:source/:id`; owns the `NewsArticleCard` twin (2 rows) | — |
| `community-hub` | exafyltd → hotmail | groups (+discover, detail, legacy my-groups), members (+profile-preview overlay), open-asks, find-partner (+board/matches/posts), `/me/matches`, intents (board/mine/match), `/search` (17 rows) | — |
| `home` | exafyltd → hotmail | `/home` (+ `?tab=all|community`, `?compose=1`), life-compass + master-action overlays, `/home/compose`, `/home/comments`, `/home/notif`; the composed feed (8 rows) | `news` |
Exact `paths` globs are in each `lanes/<id>.md`; the 27 rows partition with 0 overlap and 0 orphan (design §3).
`news` and `community-hub` run in parallel; `home` waits for `news` (the card twin).

## Test plan
- **Per lane, offline (fixture / fake gateway, no network):** from `apps/mobile/` — `npm run typecheck`, `npm test`
  (jest-expo + RNTL: loaded/empty/error per screen; Home feed-kind mapping, error-boundary isolation, tab switch,
  compose/comments/notif deep-links; news reader/post not-found/deleted; community list/detail/search/intents; i18n
  no-raw-text + RTL start/end; React 19 `ReactElement`), `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check`. From the repo root —
  `node scripts/native/core-closure.mjs --check` and `node scripts/native/parity-ledger.mjs --check` (rows `native`,
  routes present). NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- **i18n:** 11 locales (ar de en es fr pl pt ru sr tr zh), any new key DE-first (du-form) then mirrored; RTL (`ar`)
  rendered per screen.
- **Deferred to G1 (owner gate, `next_actor: owner`):** Maestro `maestro/<lane>/*.yaml`, iOS simulator + Android
  emulator screenshots at the device sizes, screenshot parity vs the 390×844 **read-only** staging web screen; listed
  in `docs/validation/<VTID>/staging-tests.json` (sign in, navigate, read; network guard aborts every non-GET except
  sign-in; never `vitanaland.com`). STAGING-VERIFY is read-only by construction (program §6).
- **No What's New entry** (ports of existing screens). No new routes → no nav-registry change and no new native parity
  row — only status flips.

## Open owner / sparring items (not decided here)
- G1 isolated test environment (program gate) — required before any device-runtime parity check; the deferred tasks
  stay `next_actor: owner` until it exists.
- macOS minutes / G3 for iOS-on-device screenshots (program STATUS row 8b) — not needed for the JS build.
- Whether `home` or `news` owns the `NewsArticleCard` twin (decision 3 default: `news`).
<!-- plan:end -->
