# Requirements — Native Wave 2: Home / Feed / News screen ports (native-wave2-home-feed-news-r2)

First Wave 2 screen-port batch of the Maxina native app program
(`docs/programs/native-app/NATIVE-APP-PLAN.md`, program VTID-05021). Port the home, feed, news and the
community-hub / intents / search screens that the parity ledger assigns to the `home-feed` lane to the native
app (`apps/mobile/`) at 1:1 parity with today's **mobile web** screens, built on `@vitana/core` + `@vitana/tokens`
+ the N2 UI kit (`@vitana/ui`) on the N3 shell. Fixture / fake-gateway tests only; runtime verification on a device
needs the isolated test environment G1 and is called out per task as `depends-on-owner`.

Measured on the worktree (= `origin/main`), parity ledger `apps/mobile/parity/ledger.json` version 2:
**27 rows carry `"lane": "home-feed"`, every one `status: "not_started"`** (19 `screen`, 3 `overlay`, 5 `route`;
435 rows total). Counted with `node -e` over the committed ledger JSON (the `--report` command needs `typescript`,
which is not installed in this worktree). The three lanes below partition those 27 rows with **disjoint `paths`**.

Contract that does not change: `docs/programs/native-app/NATIVE-APP-PLAN.md` §4 (parity method), §6 (verification &
safety), the N2 README web→native prop map (`apps/mobile/README.md` "Web → native prop map"), and the Spotlight /
design rules via tokens. No new web screen, no `App.tsx` route, no `screens.json` / `exclusions.json` entry is added
by this plan (ports only), so no `screen-manifest` or voice-registry change and no new native parity row — only
status flips on existing rows.

## R0 — Scope and the three lanes

0.1 The plan ports exactly the 27 web destinations the parity ledger lists under `"lane": "home-feed"`, split into
three disjoint lanes by cluster. No row is in two lanes; no row in scope is left without a lane.

0.2 Lane **`home`** — the Home News Feed screen and its deep-link / overlay surfaces:
`HOME.OVERVIEW /home`, `HOME.NEWS_ALL /home?tab=all`, `HOME.NEWS_COMMUNITY /home?tab=community`,
`HOME.CREATE_POST /home?compose=1`, overlays `LIFE_COMPASS.OVERLAY /home` and `OVERLAY.MASTER_ACTION /home`, and the
Home push deep-link routes `/home/compose`, `/home/comments`, `/home/notif`. Web source `src/pages/Home.tsx`
(970 lines; VTID-01900 News Feed header `src/pages/Home.tsx:1-12`).

0.3 Lane **`news`** — the long-form reader and single-post detail:
`NEWS.DETAIL /news/:id` (web `src/pages/NewsArticleDetail.tsx`, 230 lines; route `src/App.tsx:1001-1008`) and the
`/post/:source/:id` single community post / video (web `src/pages/PostDetail.tsx`, 158 lines; route
`src/App.tsx:1010-1016`). These are the two reader destinations the Home feed and like/comment pushes link into.

0.4 Lane **`community-hub`** — the community hub, intents and search that share the `home-feed` ledger lane:
`COMM.GROUPS /comm/groups` + `COMM.GROUPS_DISCOVER /comm/groups?tab=recommended` (web `src/pages/community/Groups.tsx`,
272 lines; routes `src/App.tsx:1226-1230`), `COMM.GROUP_DETAIL /comm/groups/:id` and the legacy `/comm/my-groups/:id`
(web `src/pages/community/GroupDetail.tsx`, 234 lines; route `src/App.tsx:1231-1235`), `COMM.MEMBERS /comm/members`
+ overlay `OVERLAY.PROFILE_PREVIEW /comm/members` (web `src/pages/community/Members.tsx`, 332 lines; route
`src/App.tsx:1269-1274`), `COMM.OPEN_ASKS /comm/open-asks` (web `src/pages/community/OpenAsks.tsx`, 289 lines; route
`src/App.tsx:1276-1281`), `COMM.FIND_PARTNER /comm/find-partner` + the `?view=board|matches|posts` variants (web
`src/pages/community/FindPartner.tsx`, 780 lines; route `src/App.tsx:1283-1287`), `COMM.MATCHES /me/matches` (web
`src/pages/MatchesPage.tsx`, 183 lines; route `src/App.tsx:1495-1499`), `INTENTS.BOARD /intents/board` (web
`src/pages/IntentBoard.tsx`, 225 lines; route `src/App.tsx:1508-1512`), `INTENTS.MINE /intents/mine` (web
`src/pages/MyIntents.tsx`, 202 lines; route `src/App.tsx:1517-1521`), `INTENTS.MATCH_DETAIL /intents/match/:id` (web
`src/pages/IntentMatchDetail.tsx`, 192 lines; route `src/App.tsx:1522-1526`) and `SEARCH.OVERVIEW /search` (web
`src/pages/Search.tsx`, 492 lines; route `src/App.tsx:1488-1492`).

## R1 — 1:1 parity with the mobile web screen

1.1 Each native screen mirrors the **mobile web** branch (the `useIsMobile()` ≤ 1024 px branch,
`src/hooks/use-mobile.tsx`) of its web source — same layout, same sections, same navigation, same wording. No
redesign, no added or removed section, no reordering (program §4 "Allowed native improvements only": platform
transitions, gestures, keyboard avoidance, safe areas, haptics, system sheets — nothing else).

1.2 Screens compose through the N3 shell and the N2 UI kit only: `MobileAppShell`, `TopAppBar`, `BottomNav`,
`MobileModePill`, bottom sheets, `VCard`, etc. come from `src/ports/*` (`apps/mobile/README.md` "Ports"); no web
component, no raw colour, every visual value from `@vitana/tokens`.

1.3 Web→native translation follows the README map exactly (`onClick`→`onPress`, `className`→`style`,
`toast`→`@vitana/ui/sonner`, documented `Select`/`Tooltip`/close-button/`Slider`/`Progress` differences). The four
web defects the N2 README lists (slider range thumb, progress RTL fill, inert `shouldScaleBackground`, close-button
RTL side) are **not** reproduced — the native kit's corrected behaviour is used, and no web file is touched.

1.4 Business logic, query keys, hooks, types and feed composition are reused from `@vitana/core`, never re-implemented.
A web module a lane needs that is not yet re-exported is added to `packages/core/manifest.json` with a re-export in
the same lane PR and `node scripts/native/core-closure.mjs --write` run (program §3; `apps/mobile/README.md`
"Web code: `@vitana/core`"). `@vitana/core` is the only web→native bridge; ESLint bans `@/` and relative paths into
the web `src/` from app code.

## R2 — i18n (11 locales) + RTL

2.1 Every user-visible string (including `accessibilityLabel` / `accessibilityHint`) comes from the web catalog
shards `src/i18n/<locale>/*.json`, read through the generated catalog map — no hardcoded text (repo i18n hard rule;
`apps/mobile/README.md` "i18n").

2.2 All 11 active locales resolve: **ar de en es fr pl pt ru sr tr zh** (program §1 design-system note; the live
`supported_locales` table has all 11 `status='ga'`). A new key is added to the **German shard first**
(`src/i18n/de/<screen>.json`) then mirrored to the other ten; DE is du-form.

2.3 Each screen works in RTL (`ar`): `start`/`end`, never `left`/`right`; the shell root `direction` follows the
language (`apps/mobile/README.md` N3 "Theme" row). A test scans the lane's files for physical `left`/`right`.

2.4 Adding a web i18n key is a web-deploy path. A lane that needs a genuinely new string adds the DE key first and
mirrors it; a lane that can reuse an existing key does so and adds none.

## R3 — React 19 / native typing

3.1 React 19 types: no global `JSX` namespace — use `ReactElement` (program hard rule; `.kiro/specs/health-native`
handoff "Hard rules"). `npm run typecheck` (which regenerates the i18n map first) is green.

## R4 — Parity ledger

4.1 Each lane flips its rows from `not_started` to `in_progress` while building and to `native` on completion by
running `node scripts/native/parity-ledger.mjs --sync` (status is edited by hand; `--sync` refreshes derived fields),
and NATIVE-CI `--check` is green: a `native` / `in_progress` row must have a matching route in `apps/mobile/app/`,
and no route in `app/` may lack a row (`scripts/native/parity-ledger.mjs` `check()`).

4.2 No lane changes `scope`/`lane` of a row (those come from `scripts/native/parity-scope.json`); no lane edits
another lane's rows. The three lanes touch disjoint sets of ledger rows, so the single `ledger.json` file is the one
shared path and conflicts resolve by row.

## R5 — Verification and safety (never production)

5.1 Never test against production; staging specs are read-only (program §6; root `CLAUDE.md`). The native app has
**no production profile** and `assertNotProduction()` refuses the production gateway, `vitanaland.com`, the production
Supabase project and the staging hosts (`apps/mobile/README.md` "No production host, ever").

5.2 Build-time verification per lane is offline: `npm run typecheck`, `npm test` (jest-expo + RNTL unit tests with a
**fake gateway / fixtures**, no network), `APP_PROFILE=development npm run bundle` (Metro + Hermes JS for iOS and
Android), and `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` — all from `apps/mobile/`; plus
`node scripts/native/parity-ledger.mjs --check` from the repo root. No live call is made.

5.3 Runtime parity verification (simulator / emulator screenshots, Maestro device journeys, screenshot parity vs the
390×844 web screen) is a **depends-on-owner (G1)** step: it needs the isolated test environment (and macOS minutes /
G3 for iOS on a device). Each such task is marked `next_actor: owner` in `tasks.md` and the lane records G1 as a
blocker in its log; it does not block the build-time port landing.

5.4 Each lane adds a read-only `docs/validation/<VTID>/staging-tests.json` for its screens (the VTID is written by CI
after PLAN-SPAR converges). Staging specs sign in, navigate and read; a network guard aborts every non-GET except
sign-in; never `vitanaland.com`.

5.5 No What's New entry (these are ports of existing screens, not new finished features — `CLAUDE.md` What's New rule).

## R6 — Done

6.1 Every in-scope ledger row for the lane is `native` with its native route in `apps/mobile/app/` and its
functional-parity checklist (program §4 per-screen checklist) recorded; RTL (`ar`) covered.

6.2 `npm run typecheck`, `npm test`, `npm run bundle`, `npm run deps:check` and `parity-ledger --check` green;
NATIVE-CI (incl. the shell source-pin and ports checks) and the Collab handoff + Lane scope PR-GATE checks green.

6.3 `docs/validation/<VTID>/` has `scope.json` (every touched path), `staging-tests.json` (the lane's read-only spec)
and `plan-sparring.md` (copy of this plan's sparring record).

## Out of scope (named so a lane does not drift into them)

- Any screen in another Wave 2 ledger lane (`events-calendar`, `media`, `ai`, `discover-commerce`, `inbox-chat-calls`,
  etc.) — each is its own plan.
- Live rooms, media hub, events, calendar reached from the community hub (those rows are `events-calendar` / `media`
  lanes); this plan links to them by route only.
- G1 / G2 / G3 provisioning, EAS / store build pipelines, the ORB voice module — their own plans / owner gates.
- Any web-side change beyond adding an i18n key (DE first) and a `@vitana/core` re-export line.
