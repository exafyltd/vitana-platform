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
   component folders, build/review independently, each leaves the app buildable. **Partition (R1-F2, corrected
   against the ledger): home 6 parity rows** — `HOME.OVERVIEW`, `HOME.NEWS_ALL`, `HOME.NEWS_COMMUNITY`,
   `HOME.CREATE_POST` (the `?compose=1` row) + the two `/home` overlays `LIFE_COMPASS.OVERLAY`,
   `OVERLAY.MASTER_ACTION` — **news 2 rows, community-hub 19 rows = 27** (re-counted: the earlier "home 8 /
   community-hub 17" double-counted). The three `/home/compose`, `/home/comments`, `/home/notif` App.tsx routes
   (`src/App.tsx:969-998`) are **not** parity-ledger rows; the home lane still ports them as native route files but
   they carry **no** dedicated parity row — `parity-ledger.mjs --check` covers them under `HOME.OVERVIEW` (they are
   sub-routes of `/home`), never as new rows, so the "0 orphan / only status flips" guarantee holds for the 6 rows
   and the deep-links are explicitly excluded from row accounting.
2. **Feed-composition / ranking / feed-hook modules move into `@vitana/core`, WITH their transitive type-only deps**
   (R1-F1). `feed-compose.ts` and `news-feed-ranker.ts` are not self-contained: `feed-compose.ts:27` imports a type
   from `@/lib/news-feed-ranker`, and `news-feed-ranker.ts:23-24` import `MatchReason` from `@/lib/matchReason` and
   `PostAttachedRef` from `@/lib/post-attachment`. So the extraction moves (or inlines the minimal type shapes of)
   `feed-compose`, `news-feed-ranker`, `matchReason`, `post-attachment`, plus any transitive `@/lib/*` type imports
   found in `useNewsFeed`/`useAllNewsFeed` — each as its own re-export PR — so the `@vitana/core` copies carry **no**
   `@/lib/*` imports and `core-closure.mjs --write`/`--check` passes with core self-contained. (Supersedes the earlier
   "one re-export line per module" wording, which under-scoped the transitive types.)
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
| `community-hub` | exafyltd → hotmail | groups (+discover, detail, legacy my-groups), members (+profile-preview overlay), open-asks, find-partner (+board/matches/posts), `/me/matches`, intents (board/mine/match), `/search` (**19 rows**) | — |
| `home` | exafyltd → hotmail | `/home` (+ `?tab=all|community`, `?compose=1`), life-compass + master-action overlays (**6 parity rows**); plus the `/home/compose`, `/home/comments`, `/home/notif` sub-routes ported as native route files with **no** dedicated parity row (covered under `HOME.OVERVIEW`) | `news` |
Exact `paths` globs are in each `lanes/<id>.md`; the 27 parity rows partition **6 (home) + 2 (news) + 19
(community-hub)** with 0 overlap and 0 orphan (R1-F2 re-count); the 3 `/home` deep-link sub-routes are ported but
excluded from row accounting (no ledger row, covered by `HOME.OVERVIEW` for `parity-ledger.mjs --check`).
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

## Re-spar note (2026-10-20)
The first sparring session (`759e1c03`) escalated on infrastructure (the pipeline was being fixed — code
access, Bedrock subscription, daily-token cap, and the vitana-v1 ref). Those are all resolved now: the
vitana-v1 ref fix is merged to main (PR #4201, `fa73aabd0`), so `PLAN-SPAR` forwards
`extra_refs: { 'exafyltd/vitana-v1': <sha> }` and a session created from this branch (which now has the fix
in its base, main merged in) can read `exafyltd/vitana-v1` to verify this plan's `apps/mobile/**` and web
screen premises. The sibling plan `native-g1-wiring` already converged and allocated VTIDs the same way.
This note re-triggers a fresh sparring session on the fixed pipeline.
<!-- plan:end -->
