# Plan — native-wave2-home-feed-news-r2
Author: Kiro, seat `exafyltd`. Repo: `exafyltd/vitana-v1` (native app only — `apps/mobile/**`, `packages/core/**`
via the manifest/closure process, `apps/mobile/parity/ledger.json`, DE-first i18n shards, `docs/validation/**`; no
backend, no gateway change, no migration). Spec: `requirements.md`, `design.md`, `tasks.md`, `lanes/*.md` in this
folder. Program: `docs/programs/native-app/NATIVE-APP-PLAN.md` (VTID-05021), §5 Wave 2.

<!-- plan:begin -->
## Re-plan
Re-plan of native-wave2-home-feed-news (PR #4273, converged) under a new slug; the old branch has commits without Collab trailers.
This plan supersedes the lanes `native-wave2-home-feed-news/community-hub` (VTID-05296), `native-wave2-home-feed-news/home` (VTID-05297) and `native-wave2-home-feed-news/news` (VTID-05298) of the approved plan `native-wave2-home-feed-news` (on `main`). PR #4273 widened those three lanes' `paths` to the shared native-infra files a screen port produces (`apps/mobile/src/ports/**`, `apps/mobile/src/navigation/resolve.ts`, `apps/mobile/tests/<cluster>/**`, `scripts/native/mobile-ci-paths.generated.json`); vitana-v1 lane scope rejected PRs #1475 and #1483 for files outside the old paths. A `_plan` commit may not edit an existing lane file, so the widened lanes are declared here under a new slug and get CI-allocated VTIDs. VTID-05296/05297/05298 are to be retired (terminalized `cancelled` by the PM or the exceptions seat once these lanes have their own VTIDs); this plan does not touch the ledger, and every `native-wave2-home-feed-news` file on `main` stays unchanged. The content below is the converged plan of `native-wave2-home-feed-news` unchanged except the slug and those widened `paths`.
Sparring history: https://github.com/exafyltd/vitana-platform/pull/4273 (rounds under `.kiro/specs/native-wave2-home-feed-news/sparring/` on `main`; not copied here). PLAN-SPAR spars this slug as a fresh session.
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
  `:1488-1526` (search/matches/intents). (R1-F2: these line counts are an **approximate** snapshot for
  scoping — a few files have grown since, e.g. `news-feed-ranker.ts`/`useAllNewsFeed.ts`/`FindPartner.tsx`;
  exact counts are not load-bearing. The ONE load-bearing check — that `feed-compose.ts` is IO-free — is
  confirmed at the pinned commit: ~110 lines, a single `import type { FeedItem, FeedItemKind } from
  "@/lib/news-feed-ranker"`, no runtime import anywhere including the tail, so it extracts as class A.)
- Wave 1 is on main: N3 shell + resolver route (`apps/mobile/app/(app)/[...path].tsx`, VTID-05186), N2 UI kit
  (`@vitana/ui`, VTID-05176), N1 `@vitana/core`/`@vitana/tokens` (VTID-05183). Prop map, ports and conventions in
  `apps/mobile/README.md`. The native app has no production profile; `assertNotProduction()` refuses prod/staging hosts.

## Decisions (made by Kiro as planner under the owner's "finish the native apps" instruction; sparring may revise)
1. **Three disjoint lanes by cluster** (prompt: home / feed / news). "Feed" is Home's composed feed (no separate web
   page), so: **`home`** (feed lives here), **`news`** (the `/news/:id` + `/post/:source/:id` readers), **`community-hub`**
   (the remaining `home-feed` ledger rows — community, intents, search). The three touch disjoint route files and
   component folders, build/review independently, each leaves the app buildable. **Partition (R1-F2 / R3-F1,
   corrected against the ledger): home 9 parity rows** — `HOME.OVERVIEW`, `HOME.NEWS_ALL`, `HOME.NEWS_COMMUNITY`,
   `HOME.CREATE_POST` (the `?compose=1` row) + the two `/home` overlays `LIFE_COMPASS.OVERLAY`,
   `OVERLAY.MASTER_ACTION` + the three **exclusion route rows** `/home/compose`, `/home/comments`, `/home/notif`
   (each a dedicated ledger row — `source: exclusion`, `scope: in`, `lane: home-feed`, from
   `src/navigation/registry/exclusions.json` and `scripts/native/parity-scope.json`) — **news 2 rows,
   community-hub 16 rows = 27** (9+2+16; the earlier "6+2+19" and "8+2+17" were both wrong). The three `/home/*`
   deep-links are ports WITH their own rows, not uncounted sub-routes: the home lane creates their native route files
   **and flips all three rows `not_started`→`native`** alongside the 6 registry rows. `parity-ledger.mjs` matches by
   exact `shapeOf()` (`:60`), not prefix, so `/home/compose` is never "covered under `/home`"; if the native files
   exist but the rows stay `not_started`, `--check` passes silently (check (d) sees the shapes via the exclusion
   rows; check (c) only fires on `native`/`in_progress`) while the ledger reports the home lane permanently
   incomplete. The home-lane acceptance therefore REQUIRES flipping all 9 rows to `native`.
2. **Only the pure IO-free compose/rank modules move into `@vitana/core`; the data-fetching hooks do NOT**
   (R1-F1, R2-F1, R2-F2). Core gets re-export entries for exactly **`feed-compose` and `news-feed-ranker`** — both
   pure. Their only cross-module references, `news-feed-ranker.ts:23-24`'s `import type { MatchReason }` from
   `@/lib/matchReason` and `import type { PostAttachedRef }` from `@/lib/post-attachment`, are **type-only**, which
   `scripts/native/extraction-deps.mjs:183` excludes from the runtime graph, and the native tsconfig `@/*` →
   `../../src/*` alias (`apps/mobile/tsconfig.json:11`) already resolves them at compile time — so `matchReason` and
   `post-attachment` get **no** core re-export PR. That matters: giving them a core entry would pull them into the
   `core-closure.mjs` BFS, where their *runtime* imports (`matchReason.ts:1` → `@/lib/i18n-toast`; `post-attachment.ts:11`
   → `@/integrations/supabase/client.ts`, a class-B module with `import.meta.env` / `localStorage` / the prod Supabase
   URL) make `core-closure --check` fail (`core-closure.mjs:150`, `m.own !== 'A'`). The **feed hooks
   `useNewsFeed`/`useAllNewsFeed` are NOT moved into core** either — they runtime-import `supabase/client.ts`
   (`useAllNewsFeed.ts:18`, `useNewsFeed.ts:10`) and would fail the same closure gate; instead the `home` lane
   **re-implements the fetching natively** (native Supabase client + native auth context) and consumes
   `composeFeed`/`rankFeed` from core. So the core extraction is two pure modules, with `core-closure --write`/`--check`
   passing and no class-B file reachable. (Supersedes both the earlier "one re-export line per module" and the
   over-scoped "transitive modules each get a re-export PR" wording.) **The core-extraction work is owned by the
   `home` lane (R2-F1), no separate lane.** The home lane PR adds `packages/core/src/feed-compose.ts` and
   `packages/core/src/news-feed-ranker.ts` (the re-export entries) + the matching `packages/core/manifest.json`
   lines, and **in the same PR** runs `node scripts/native/core-closure.mjs --write` and commits the regenerated
   `packages/core/closure.generated.json` and `scripts/native/mobile-ci-paths.generated.json`, so `--check` passes.
   `news` and `community-hub` consume core but do not add core entries. This keeps the "same PR as the re-export"
   governance rule owned by exactly one lane, so a reviewer of the home PR knows to check for the generated-file
   commits.
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
| `community-hub` | exafyltd → hotmail | groups (+discover, detail, legacy my-groups), members (+profile-preview overlay), open-asks, find-partner (+board/matches/posts), `/me/matches`, intents (board/mine/match), `/search` (**16 rows**) | — |
| `home` | exafyltd → hotmail | `/home` (+ `?tab=all|community`, `?compose=1`), life-compass + master-action overlays, and the 3 exclusion routes `/home/compose`, `/home/comments`, `/home/notif` (**9 parity rows**, all flipped `not_started`→`native`); **AND owns the core extraction** — `packages/core/src/{feed-compose,news-feed-ranker}.ts` re-exports + `packages/core/manifest.json` lines, with `core-closure.mjs --write` run and `packages/core/closure.generated.json` + `scripts/native/mobile-ci-paths.generated.json` committed in the same PR (R2-F1) | `news` |
Exact `paths` globs are in each `lanes/<id>.md`; the 27 parity rows partition **9 (home) + 2 (news) + 16
(community-hub)** with 0 overlap and 0 orphan (R3-F1 re-count); the 3 `/home/*` deep-links are dedicated
exclusion rows the home lane flips to `native` (exact `shapeOf` match, not prefix — `parity-ledger.mjs:60`).
`news` and `community-hub` run in parallel; `home` waits for `news` (the card twin).

## Test plan
- **Per lane, offline (fixture / fake gateway, no network):** from `apps/mobile/` — `npm run typecheck`, `npm test`
  (jest-expo + RNTL: loaded/empty/error per screen; Home feed-kind mapping, error-boundary isolation, tab switch,
  compose/comments/notif deep-links; news reader/post not-found/deleted; community list/detail/search/intents; i18n
  no-raw-text + RTL start/end; React 19 `ReactElement`), `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check`. From the repo root —
  `node scripts/native/parity-ledger.mjs --check` (rows `native`, routes present).
- **Core extraction deliverable (R1-F1): run `--write` AND commit the generated files, not just `--check`.** The PR
  that adds the `feed-compose`/`news-feed-ranker` re-export entries to `packages/core/src/` MUST also run
  `node scripts/native/core-closure.mjs --write` and commit the regenerated
  `packages/core/closure.generated.json` and `scripts/native/mobile-ci-paths.generated.json` in the SAME PR, then
  `node scripts/native/core-closure.mjs --check` passes. Without the `--write`+commit, `--check` fails in NATIVE-CI
  with "stale generated file" regardless of whether the modules are class A. (Confirmed IO-free premise: at
  the pinned commit, `src/lib/feed-compose.ts` is ~110 lines with a single `import type … from "@/lib/news-feed-ranker"`
  and no runtime import through its tail — so after `--write` the core copy is class A.)
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
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
