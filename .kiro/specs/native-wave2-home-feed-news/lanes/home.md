---
lane: home
state: ready
next_actor: kiro
depends_on: [news]
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(app)/home/**
  - apps/mobile/src/screens/home/**
  - apps/mobile/maestro/home/**
  - packages/core/manifest.json
  - packages/core/closure.generated.json
  - packages/core/src/**
  - apps/mobile/parity/ledger.json
  - src/i18n/*/homeNative.json
  - docs/validation/**
updated: 2026-10-23T12:10Z
vtid: VTID-05297
---
# Home / feed port — `/home` (+ tabs, compose) + its deep-link / overlay surfaces (the composed feed)
Plan: `.kiro/specs/native-wave2-home-feed-news/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: home -->` (tasks 1–8) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start
before `vtid:` is set here. **depends_on `news`:** this lane consumes the `NewsArticleCard` native twin that the
`news` lane owns (design decision 3) — start only after `news` is `done`.
**Measured on the worktree (= origin/main):** 8 ledger rows under `"lane": "home-feed"` for this lane, all
`not_started` — `HOME.OVERVIEW /home`, `HOME.NEWS_ALL /home?tab=all`, `HOME.NEWS_COMMUNITY /home?tab=community`,
`HOME.CREATE_POST /home?compose=1`, overlays `LIFE_COMPASS.OVERLAY /home` and `OVERLAY.MASTER_ACTION /home`, and the
Home push deep-link routes `/home/compose`, `/home/comments`, `/home/notif`. Web source `src/pages/Home.tsx`
(970 lines; VTID-01900 News Feed, header `src/pages/Home.tsx:1-12`; routes `src/App.tsx:946-999`). Feed modules reused
from `@vitana/core`: `lib/feed-compose.ts` (98), `lib/news-feed-ranker.ts` (351), `hooks/useNewsFeed.ts` (306),
`hooks/useAllNewsFeed.ts` (676), `hooks/useEnrichmentCards.ts`, `components/vitana/vitana-card-catalog.ts`;
create-post sheet twin of `src/components/profile/mobile/MobileCreatePostSheet.tsx`; feed error boundary twin of
`src/components/feed/FeedItemErrorBoundary.tsx` (36).
**Goal.** Port the Home News Feed to native on the N3 shell at 1:1 mobile-web parity: the composed `FeedItem[]`
(article / community post / enrichment / server / new-member cards) in a `FlatList` of `VCard`s with a native error
boundary, pull-to-refresh, infinite scroll, the All/Community tabs via the `tab` search param, header chips and the
`MobileModePill`, plus the compose sheet (`?compose=1` / `/home/compose`), the comments deep-link sheet
(`/home/comments`) and `/home/notif` (render feed, suppress the front-door overlay, web `src/App.tsx:992-999`). The
feed-composition modules move into `@vitana/core` (task 1) rather than being re-implemented. Flips the 8 parity rows
to `native`.
**Acceptance (the reviewer seat checks these):**
- Requirements R1–R6 for the Home surfaces; mobile-web parity; `@vitana/core`-only web bridge; the `NewsArticleCard`
  twin consumed via a port from `news` (not re-owned here).
- `npm run typecheck`, `npm test` (feed loaded/empty/error; each `FeedItem` kind → right card; error boundary isolates
  one bad card; All/Community tab switch; compose/comments/notif deep-link states),
  `APP_PROFILE=development npm run bundle`, `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (from
  `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/core-closure.mjs --check` and `node scripts/native/parity-ledger.mjs --check` green with the 8
  rows `native` and their routes present in `apps/mobile/app/`.
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form) then mirrored; RTL (`ar`) covered; no
  hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (this lane's read-only spec) and `plan-sparring.md`.
- **Device-runtime parity (task 7)** is deferred to G1 as `next_actor: owner`; not a merge blocker, recorded in this
  log and `staging-tests.json`.
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 8 rows), `packages/core/manifest.json`
+ closure + `src/**` (only this lane's re-exports — the feed modules), and the DE-first i18n shard are shared by
row/line; resolve a merge conflict by keeping both lanes' rows/keys.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only; the native app has no production profile.
## Log
### 2026-10-16T12:00Z · kiro-planner · created → ready
Lane drafted with the plan (`state: drafted` in `handoff.md`). The 8 rows and the paths were computed from the parity
ledger and `src/App.tsx` so no file belongs to two lanes; `depends_on: [news]` because the `NewsArticleCard` twin is
owned by `news`. Next: PLAN-SPAR spars the plan; once a VTID is written here, seat `exafyltd` claims the lane
(`queue.mjs claim native-wave2-home-feed-news/home --session <id>`) after `news` is `done`.

### 2026-10-21T11:19Z · ci-plan-spar · ready (VTID allocated)
VTID-05297 allocated after policy approval (converged-auto-v1).

### 2026-10-23T12:10Z · kiro-exafyltd-202610220818-5273 · ready (owner takeover; STAGING-VERIFY fix merged)
Owner instruction in Kiro Web 2026-10-23: "Take over native-wave2-home-feed-news/home and merge the APP_PROFILE fix."
Released the claim of `kiro-202610151913-51bd` and claimed the lane. The lane's code was merged earlier as
exafyltd/vitana-v1#1493 (`a705e2182`); its state here was never advanced past `ready` (left unchanged).
STAGING-VERIFY run https://github.com/exafyltd/vitana-platform/actions/runs/39870086198 (staging `77cb11280`) failed
only on this lane's `npm run bundle` (no APP_PROFILE). merge: f36cd6b63d1fb487bb5900b798413bc8afb9f52d
(exafyltd/vitana-v1#1495, docs only: `env: {APP_PROFILE: development}` on that entry; every check green after one
re-run of an infra failure). authority: the owner instruction above (§7b owner-named). Reviewer agent not available
in this session; no model substituted. Next: STAGING-VERIFY on the first staging deploy at or after `f36cd6b6`.
