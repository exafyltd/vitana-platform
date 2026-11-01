# Tasks — Native Wave 2: Home / Feed / News screen ports

Three lanes, disjoint `paths`. Design: `design.md` and `requirements.md` in this folder are authoritative — follow
them exactly; anything outside them is a plan change (log it, set `next_actor: claude`). VTIDs are assigned by CI
after PLAN-SPAR converges; do not start a lane before its `vtid:` is set in `lanes/<id>.md`. All commands run from
`apps/mobile/` unless noted; `assertNotProduction()` and the no-production-profile rule make every command offline.

<!-- lane: home -->
## Lane `home` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports: `HOME.OVERVIEW /home`, `HOME.NEWS_ALL /home?tab=all`, `HOME.NEWS_COMMUNITY /home?tab=community`,
`HOME.CREATE_POST /home?compose=1`, `LIFE_COMPASS.OVERLAY /home`, `OVERLAY.MASTER_ACTION /home`,
`/home/compose`, `/home/comments`, `/home/notif` (8 ledger rows under `"lane": "home-feed"`). depends_on: `news`
(for the `NewsArticleCard` native twin, design §2b/decision 3). Web source `src/pages/Home.tsx` (970 lines).

- [ ] 1. Re-export the two pure feed modules through `@vitana/core` (plan decision 2): manifest lines and re-exports
  in `packages/core/src/**` for `src/lib/feed-compose.ts` and `src/lib/news-feed-ranker.ts` only (the feed hooks are
  re-implemented natively, task 2a), then `node scripts/native/core-closure.mjs --write`.
  Files: `packages/core/manifest.json`, `packages/core/src/**`, `packages/core/closure.generated.json`.
  Verify (repo root): `node scripts/native/core-closure.mjs --check` passes; `apps/mobile` → `npm run typecheck` green.
- [ ] 2a. Native feed fetching (plan decision 2, s2 R1-F2): native twins of `useAllNewsFeed` / `useNewsFeed` in
  `apps/mobile/src/screens/home/**` covering Supabase queries + realtime channels, query-cache persistence (or an
  explicit no-op), `attachedRefOf`, session and language filter, toasts via native i18n, feed preferences, matches,
  the longevity feed, gateway calls through the native port, and new-member greeting state; all fixture-tested.
  Files: `apps/mobile/src/screens/home/**`, `apps/mobile/src/ports/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 2. Native Home screen on the N3 shell: `apps/mobile/src/screens/home/HomeScreen.tsx` renders the composed
  `FeedItem[]` (from the core compose/rank modules) in a `FlatList` of `VCard`s, one native card component per item
  kind (article twin from the `news` lane via a port, community post, enrichment card, server card, new-member card),
  wrapped in a native error boundary (twin of `src/components/feed/FeedItemErrorBoundary.tsx`). Pull-to-refresh,
  infinite scroll, the All/Community tabs via the `tab` search param, header chips (`VitanaIndexChip`/`AutopilotChip`
  twins or the shell's), and the `MobileModePill`. Mobile-web branch of `Home.tsx` only.
  Files: `apps/mobile/app/(app)/home/index.tsx`, `apps/mobile/src/screens/home/**`.
  Verify: `npm test` (the Home unit tests below) + `npm run typecheck` green.
- [ ] 3. Compose / comments / notif surfaces: the create-post bottom sheet (twin of
  `src/components/profile/mobile/MobileCreatePostSheet.tsx`) opened by `?compose=1` and the `/home/compose` deep link;
  the comments sheet auto-opened by `/home/comments` (web `commentsDeepLinkActive`); `/home/notif` renders the feed
  and suppresses the front-door overlay (web `src/App.tsx:992-999`).
  Files: `apps/mobile/app/(app)/home/compose.tsx`, `apps/mobile/app/(app)/home/comments.tsx`,
  `apps/mobile/app/(app)/home/notif.tsx`, `apps/mobile/src/screens/home/**`.
  Verify: `npm test` — deep-link tests resolve each route to the right screen/sheet state; `npm run typecheck` green.
- [ ] 4. i18n + RTL: user-visible strings from the web shards; any genuinely new key added to `src/i18n/de/*.json`
  first, then the other ten (ar de en es fr pl pt ru sr tr zh); render under `ar` with start/end only; no hardcoded
  text, no physical `left`/`right`.
  Files: `src/i18n/*/<home screens>.json` (DE first), `apps/mobile/src/screens/home/**`.
  Verify: `npm run typecheck`; `npm test` — the no-raw-text and no-physical-direction tests pass.
- [ ] 5. Unit tests (fake gateway / fixtures, no network): loaded feed, empty feed, feed error; each `FeedItem` kind
  maps to the right card; error boundary isolates one bad card; All/Community tab switch; compose/comments/notif
  deep-link states. React 19 — `ReactElement`, no global `JSX`.
  Files: `apps/mobile/src/screens/home/__tests__/**`, `apps/mobile/app/(app)/home/__tests__/**`.
  Verify: `npm test` green; `APP_PROFILE=development npm run bundle` and
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 6. Flip the lane's parity rows to `native` and verify: `node scripts/native/parity-ledger.mjs --sync` (status
  edited by hand to `native`), then `--check`.
  Files: `apps/mobile/parity/ledger.json` (home rows only), `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 7. **(depends-on-owner / G1 — `next_actor: owner`)** Device-runtime parity: Maestro journey(s)
  `apps/mobile/maestro/home/*.yaml`, iOS simulator + Android emulator screenshots at the device sizes, screenshot
  parity vs the 390×844 read-only staging web `/home`. Blocked until G1 (and macOS minutes / G3 for iOS on a device).
  Files: `apps/mobile/maestro/home/**`, `docs/validation/<VTID>/staging-tests.json`.
  Verify: on G1 only; recorded in the lane log, not run in CI.
- [ ] 8. PR: branch `kiro/native-wave2-home-feed-news-r2/home`, title
  `VTID-xxxxx (native-wave2-home-feed-news-r2/home): native Home / feed port`, body names the Kiro session id, Summary /
  Decisions taken / Tests / Handoff. Commit trailers `Collab-Session: <kiro id>`,
  `Collab-Lane: native-wave2-home-feed-news-r2/home`. Lane → `in-review`, `next_actor: kiro` (reviewer seat `hotmail`).
  Never merge, deploy or write to a live system (protocol §7a).

<!-- lane: news -->
## Lane `news` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports: `NEWS.DETAIL /news/:id` and `/post/:source/:id` (2 ledger rows). depends_on: none. Web sources
`src/pages/NewsArticleDetail.tsx` (230 lines, route `src/App.tsx:1001-1008`), `src/pages/PostDetail.tsx`
(158 lines, route `src/App.tsx:1010-1016`). This lane also owns the `NewsArticleCard` native twin (design decision 3).

- [ ] 1. `NewsArticleCard` native twin (shared with Home via a port): `apps/mobile/src/screens/news/NewsArticleCard.tsx`
  mirrors `src/components/crossover/NewsArticleCard.tsx` (image primary + fallback swap, pillar, `expo-image`). Add any
  pure helper it needs (`src/lib/news-images.ts`) to `@vitana/core` via the manifest + `core-closure.mjs --write`.
  Files: `apps/mobile/src/screens/news/NewsArticleCard.tsx`, `packages/core/manifest.json`, `packages/core/src/**`,
  `packages/core/closure.generated.json`.
  Verify (repo root): `node scripts/native/core-closure.mjs --check`; `apps/mobile` → `npm run typecheck` green.
- [ ] 2. News article reader `apps/mobile/app/(app)/news/[id].tsx` + `apps/mobile/src/screens/news/NewsDetailScreen.tsx`:
  full-screen reader twin of `NewsArticleDetail.tsx` on the N3 shell, back-navigation (gesture + button), open from a
  feed card and from a deep link. Mobile-web branch only.
  Files: `apps/mobile/app/(app)/news/[id].tsx`, `apps/mobile/src/screens/news/NewsDetailScreen.tsx`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 3. Single post / video `apps/mobile/app/(app)/post/[source]/[id].tsx` +
  `apps/mobile/src/screens/news/PostDetailScreen.tsx`: twin of `PostDetail.tsx`, the like/comment-notification deep-link
  target; `<video>` → `expo-video`, images → `expo-image`.
  Files: `apps/mobile/app/(app)/post/[source]/[id].tsx`, `apps/mobile/src/screens/news/PostDetailScreen.tsx`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 4. i18n + RTL (as home task 4) for the two readers + the card.
  Files: `src/i18n/*/<news screens>.json` (DE first), `apps/mobile/src/screens/news/**`.
  Verify: `npm run typecheck`; `npm test` no-raw-text / no-physical-direction tests pass.
- [ ] 5. Unit tests (fake gateway / fixtures): article loaded / not-found / error; post loaded / deleted / error;
  card image fallback swap; open-from-deep-link resolves the right screen. React 19 `ReactElement`.
  Files: `apps/mobile/src/screens/news/__tests__/**`, `apps/mobile/app/(app)/news/__tests__/**`,
  `apps/mobile/app/(app)/post/__tests__/**`.
  Verify: `npm test`; `APP_PROFILE=development npm run bundle`;
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 6. Flip the lane's parity rows (`NEWS.DETAIL`, `/post/:source/:id`) to `native`; `--sync` then `--check`.
  Files: `apps/mobile/parity/ledger.json` (news rows only), `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 7. **(depends-on-owner / G1 — `next_actor: owner`)** Maestro `apps/mobile/maestro/news/*.yaml` + sim/emulator
  screenshots + parity vs 390×844 staging `/news/:id` and `/post/:source/:id`. Blocked until G1 (+ macOS/G3 for iOS).
  Files: `apps/mobile/maestro/news/**`, `docs/validation/<VTID>/staging-tests.json`.
- [ ] 8. PR: branch `kiro/native-wave2-home-feed-news-r2/news`, title
  `VTID-xxxxx (native-wave2-home-feed-news-r2/news): native news / post reader port`; trailers `Collab-Session`,
  `Collab-Lane: native-wave2-home-feed-news-r2/news`; lane → `in-review`, `next_actor: kiro`. No merge/deploy/live write.

<!-- lane: community-hub -->
## Lane `community-hub` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports (17 ledger rows): `COMM.GROUPS`, `COMM.GROUPS_DISCOVER`, `COMM.GROUP_DETAIL`, `/comm/my-groups/:id`,
`COMM.MEMBERS` + `OVERLAY.PROFILE_PREVIEW`, `COMM.OPEN_ASKS`, `COMM.FIND_PARTNER` (+ `?view=board|matches|posts`),
`COMM.MATCHES /me/matches`, `INTENTS.BOARD`, `INTENTS.MINE`, `INTENTS.MATCH_DETAIL`, `SEARCH.OVERVIEW /search`.
depends_on: none. Web sources per requirements R0.4 (with App.tsx line cites).

- [ ] 1. Core re-exports: add the hooks/types the community, intents and search screens use (group, members,
  find-partner, intents, search query hooks) to `@vitana/core` via the manifest + `core-closure.mjs --write`, reusing
  the web member-listing queries unchanged so the test/service allowlist exclusion (program NEVER 45) is inherited,
  not re-implemented.
  Files: `packages/core/manifest.json`, `packages/core/src/**`, `packages/core/closure.generated.json`.
  Verify (repo root): `node scripts/native/core-closure.mjs --check`; `apps/mobile` → `npm run typecheck` green.
- [ ] 2. Groups: `apps/mobile/app/(app)/comm/groups/index.tsx` (list + `?tab=recommended` discover),
  `apps/mobile/app/(app)/comm/groups/[id].tsx` and `apps/mobile/app/(app)/comm/my-groups/[id].tsx` (same detail
  screen) + `apps/mobile/src/screens/community/Groups*.tsx`. Twins of `Groups.tsx` / `GroupDetail.tsx`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 3. Members + profile-preview overlay (`apps/mobile/app/(app)/comm/members.tsx`,
  `src/screens/community/MembersScreen.tsx`), Open Asks (`.../comm/open-asks.tsx`), Find a Partner with the
  board/matches/posts views via `?view=` (`.../comm/find-partner.tsx`), full matches list
  (`.../me/matches.tsx`). Twins of `Members.tsx`, `OpenAsks.tsx`, `FindPartner.tsx`, `MatchesPage.tsx`.
  Files: `apps/mobile/app/(app)/comm/**`, `apps/mobile/app/(app)/me/matches.tsx`,
  `apps/mobile/src/screens/community/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 4. Intents (`.../intents/board.tsx`, `.../intents/mine.tsx`, `.../intents/match/[id].tsx`) and global Search
  (`.../search.tsx`). Twins of `IntentBoard.tsx`, `MyIntents.tsx`, `IntentMatchDetail.tsx`, `Search.tsx`. The native
  `Slider`/`Progress` corrected behaviour (N2 README web defects) is used in the find-match / age-range filter.
  Files: `apps/mobile/app/(app)/intents/**`, `apps/mobile/app/(app)/search.tsx`,
  `apps/mobile/src/screens/community/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 5. i18n + RTL (as home task 4) across all community-hub screens; new keys DE-first then the other ten.
  Files: `src/i18n/*/<community/intents/search screens>.json` (DE first), `apps/mobile/src/screens/community/**`.
  Verify: `npm run typecheck`; `npm test` no-raw-text / no-physical-direction tests pass.
- [ ] 6. Unit tests (fake gateway / fixtures) per screen type: list load / scroll-end / empty / error; detail open
  from list and deep link + back; find-partner view switch; members profile-preview open/dismiss; search query →
  results / empty; intents board / mine / match-detail. React 19 `ReactElement`.
  Files: `apps/mobile/src/screens/community/__tests__/**`, `apps/mobile/app/(app)/**/__tests__/**`.
  Verify: `npm test`; `APP_PROFILE=development npm run bundle`;
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 7. Flip the 17 parity rows to `native`; `--sync` then `--check`.
  Files: `apps/mobile/parity/ledger.json` (community-hub rows only), `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 8. **(depends-on-owner / G1 — `next_actor: owner`)** Maestro `apps/mobile/maestro/community/*.yaml` +
  sim/emulator screenshots + parity vs the 390×844 read-only staging screens. Blocked until G1 (+ macOS/G3 for iOS).
  Files: `apps/mobile/maestro/community/**`, `docs/validation/<VTID>/staging-tests.json`.
- [ ] 9. PR: branch `kiro/native-wave2-home-feed-news-r2/community-hub`, title
  `VTID-xxxxx (native-wave2-home-feed-news-r2/community-hub): native community hub / intents / search port`; trailers
  `Collab-Session`, `Collab-Lane: native-wave2-home-feed-news-r2/community-hub`; lane → `in-review`, `next_actor: kiro`.
  No merge/deploy/live write.

## Acceptance (every lane; the reviewer seat checks these)
- Requirements R1–R6 met for the lane's screens; mobile-web parity, N2/N3 composition, `@vitana/core`-only bridge.
- `npm run typecheck`, `npm test`, `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green; `node scripts/native/parity-ledger.mjs --check`
  green with the lane's rows `native`; `node scripts/native/core-closure.mjs --check` green.
- 11 locales, DE-first new keys, RTL covered; no hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** and **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (read-only) and `plan-sparring.md`.
- Device-runtime parity (task 7/8) is deferred to G1 as `next_actor: owner`; it is not a merge blocker for the port,
  it is recorded in the lane log and `staging-tests.json`.
- Never: VTID allocation, merge/approve, workflow dispatch, deploy, Supabase/AWS writes, or any test against
  production (protocol §7a; program §6).
