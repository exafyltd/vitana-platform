# Requirements — Native Wave 2: Events / Meetups / Calendar / Reminders / Live-rooms screen ports (native-wave2-events-calendar)
Second Wave 2 screen-port batch of the Maxina native app program
(`docs/programs/native-app/NATIVE-APP-PLAN.md`, program VTID-05021). Port the events, meetups, calendar, reminders and
live-rooms screens that the parity ledger assigns to the `events-calendar` lane to the native app (`apps/mobile/`) at
1:1 parity with today's **mobile web** screens, built on `@vitana/core` + `@vitana/tokens` + the N2 UI kit
(`@vitana/ui`) on the N3 shell. Fixture / fake-gateway tests only; runtime verification on a device needs the isolated
test environment G1 and is called out per task as `depends-on-owner` — the live-rooms Daily.co join especially.
Measured on the worktree (= `origin/main`), parity ledger `apps/mobile/parity/ledger.json` version 2:
**22 rows carry `"lane": "events-calendar"`, every one `status: "not_started"`** (14 `screen`, 3 `overlay` — incl. the
`/calendar` overlay — and 6 exclusion `route`; 435 rows total). Counted with `node -e` over the committed ledger JSON
(the `--report` command needs `typescript`, which is not installed in this worktree). The three lanes below partition
those 22 rows with **disjoint `paths`**.
Contract that does not change: `docs/programs/native-app/NATIVE-APP-PLAN.md` §4 (parity method), §6 (verification &
safety), the N2 README web→native prop map (`apps/mobile/README.md` "Web → native prop map"), and the Spotlight /
design rules via tokens. No new web screen, no `App.tsx` route, no `screens.json` / `exclusions.json` entry is added
by this plan (ports only), so no `screen-manifest` or voice-registry change and no new native parity row — only
status flips on existing rows.
## R0 — Scope and the three lanes
0.1 The plan ports exactly the 22 web destinations the parity ledger lists under `"lane": "events-calendar"`, split
into three disjoint lanes by cluster. No row is in two lanes; no row in scope is left without a lane.
0.2 Lane **`events-meetups`** — the events / meetups hub and its drawers + public/game landings:
`COMM.EVENTS /comm/events-meetups`, `COMM.EVENTS_HOT ?tab=hot`, `COMM.EVENTS_TODAY ?tab=today`,
`COMM.EVENTS_UPCOMING ?tab=upcoming`, `COMM.FEED ?tab=following`, `COMM.OVERVIEW ?tab=hot`, overlays
`OVERLAY.EVENT_DRAWER` and `OVERLAY.MEETUP_DRAWER`, and the 4 exclusion routes `/community/event-game`, `/e/:slug`,
`/e/game/:slug`, `/pub/events/:id`. Web sources `src/pages/community/EventsAndMeetups.tsx` (1489 lines; route
`src/App.tsx:1242-1249`), `src/components/CreateEventPopup.tsx` (912, class-B), `src/components/CreateMeetupPopup.tsx`
(593, class-B), `src/components/EditMeetupPopup.tsx` (857, class-B), `src/pages/community/EventGamePage.tsx` (134;
route `src/App.tsx:953`), `src/pages/EventGamePublicLanding.tsx` (162), `src/pages/PublicEventLanding.tsx` (514; routes
`src/App.tsx:851-857`). **12 rows.**
0.3 Lane **`calendar-reminders`** — the calendar overlay/screen and the reminders screen + their deep-link routes:
`CALENDAR.OVERVIEW /calendar` (overlay), `REMINDERS.OVERVIEW /reminders` (screen), `/calendar/entry/:entryId`
(exclusion), `/reminders/fire/:fireId` (exclusion). Web sources `src/pages/Calendar.tsx` (552 lines, class-B; routes
`src/App.tsx:1185-1201`) + the `src/components/calendar/vcal/**` subtree + `src/components/calendar/MobileEventForm.tsx`,
`src/pages/Reminders.tsx` (66 lines; routes `src/App.tsx:1203-1219`), `src/components/reminders/RemindersPanel.tsx`
(425), `src/components/reminders/ReminderInterruptOverlay.tsx` (252). **4 rows.**
0.4 Lane **`live-rooms`** — the live-rooms list + viewer (Daily.co): `COMM.LIVE_ROOMS /comm/live-rooms`,
`COMM.LIVE_ROOMS_ALL ?tab=all`, `COMM.LIVE_ROOMS_LIVE ?tab=live`, `COMM.LIVE_ROOMS_PAST ?tab=past`,
`COMM.LIVE_ROOMS_SCHEDULED ?tab=scheduled`, `COMM.LIVE_ROOM_VIEWER /comm/live-rooms/:roomId/view`. Web sources
`src/pages/community/LiveRooms.tsx` (1073 lines, class-B; route `src/App.tsx:1253-1255`),
`src/pages/community/LiveRoomViewer.tsx` (421 lines, class-B; route `src/App.tsx:1258-1260`),
`src/components/liverooms/DailyVideoRoom.tsx` (88, Daily.co), `src/components/liverooms/LiveRoomDrawer.tsx` (670),
`src/components/events/EventsLiveRooms.tsx` (281). **6 rows.** 12 + 4 + 6 = 22.
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
web defects the N2 README lists are **not** reproduced — the native kit's corrected behaviour is used, and no web file
is touched.
1.4 Business logic, query keys, hooks, types reused from `@vitana/core`, never re-implemented **where class-A**. The
screen pages and dialogs in this cluster are **class-B** (runtime-import `@/integrations/supabase/client.ts`) and are
re-implemented natively (native Supabase client + native auth context, Wave 1 pattern) — **never moved into
`@vitana/core`**. Only pure, IO-free helper modules a lane needs are added to `packages/core/manifest.json` with a
re-export in the same lane PR and `node scripts/native/core-closure.mjs --write` run (program §3). `@vitana/core` is
the only web→native bridge; ESLint bans `@/` and relative paths into the web `src/` from app code. A helper the
closure BFS proves reaches a class-B module is re-implemented natively, not forced into core.
## R2 — i18n (11 locales) + RTL + dates/times
2.1 Every user-visible string (including `accessibilityLabel` / `accessibilityHint`) comes from the web catalog
shards `src/i18n/<locale>/*.json`, read through the generated catalog map — no hardcoded text (repo i18n hard rule;
`apps/mobile/README.md` "i18n").
2.2 All 11 active locales resolve: **ar de en es fr pl pt ru sr tr zh**. A new key is added to the **German shard
first** (`src/i18n/de/<screen>.json`) then mirrored to the other ten; DE is du-form.
2.3 Each screen works in RTL (`ar`): `start`/`end`, never `left`/`right`; the shell root `direction` follows the
language. A test scans the lane's files for physical `left`/`right`.
2.4 Adding a web i18n key is a web-deploy path. A lane that needs a genuinely new string adds the DE key first and
mirrors it; a lane that can reuse an existing key does so and adds none.
2.5 **Dates and times (load-bearing, ESLint `i18n/no-raw-locale-call` ERROR):** every date/time rendered via `fmtDate`
/ `fmtTime` / `fmtDateTime` / `formatDate` (+ the `formatDistance` family) from `@/lib/locale-format` — never raw
`toLocaleDateString`/`toLocaleTimeString`/`toLocaleString`, never `date-fns` `format` directly. This is densest on the
`calendar-reminders` lane (entries, FindTime, overlap windows, reminder fire times) and also applies to event
start/end times and live-room scheduled / "starting soon" labels.
## R3 — React 19 / native typing
3.1 React 19 types: no global `JSX` namespace — use `ReactElement` (program hard rule). `npm run typecheck` (which
regenerates the i18n map first) is green.
## R4 — Parity ledger
4.1 Each lane flips its rows from `not_started` to `in_progress` while building and to `native` on completion by
running `node scripts/native/parity-ledger.mjs --sync` (status is edited by hand; `--sync` refreshes derived fields),
and NATIVE-CI `--check` is green: a `native` / `in_progress` row must have a matching route in `apps/mobile/app/`, and
no route in `app/` may lack a row (`scripts/native/parity-ledger.mjs` `check()`).
4.2 No lane changes `scope`/`lane` of a row (those come from `scripts/native/parity-scope.json`); no lane edits
another lane's rows. The three lanes touch disjoint sets of ledger rows, so the single `ledger.json` file is the one
shared path and conflicts resolve by row.
## R5 — Verification and safety (never production)
5.1 Never test against production; staging specs are read-only (program §6; root `CLAUDE.md`). The native app has
**no production profile** and `assertNotProduction()` refuses the production gateway, `vitanaland.com`, the production
Supabase project and the staging hosts (`apps/mobile/README.md` "No production host, ever").
5.2 Build-time verification per lane is offline: `npm run typecheck`, `npm test` (jest-expo + RNTL unit tests with a
**fake gateway / fixtures**, no network), `APP_PROFILE=development npm run bundle`, and
`APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` — all from `apps/mobile/`; plus
`node scripts/native/parity-ledger.mjs --check` from the repo root. No live call is made.
5.3 Runtime parity verification (simulator / emulator screenshots, Maestro device journeys, screenshot parity vs the
390×844 web screen) is a **depends-on-owner (G1)** step: it needs the isolated test environment (and macOS minutes /
G3 for iOS on a device). Each such task is marked `next_actor: owner` in `tasks.md` and the lane records G1 as a
blocker in its log; it does not block the build-time port landing. **The live-rooms Daily.co video join has no offline
substitute and is fully G1-deferred.**
5.4 Each lane adds a read-only `docs/validation/<VTID>/staging-tests.json` for its screens (the VTID is written by CI
after PLAN-SPAR converges). Staging specs sign in, navigate and read; a network guard aborts every non-GET except
sign-in; never `vitanaland.com`.
5.5 No What's New entry (these are ports of existing screens, not new finished features — `CLAUDE.md` What's New rule).
## R6 — Done
6.1 Every in-scope ledger row for the lane is `native` with its native route in `apps/mobile/app/` and its
functional-parity checklist (program §4 per-screen checklist) recorded; RTL (`ar`) covered.
6.2 `npm run typecheck`, `npm test`, `npm run bundle`, `npm run deps:check`, `parity-ledger --check` and
`core-closure --check` green; NATIVE-CI (incl. the shell source-pin and ports checks) and the Collab handoff + Lane
scope PR-GATE checks green.
6.3 `docs/validation/<VTID>/` has `scope.json` (every touched path), `staging-tests.json` (the lane's read-only spec)
and `plan-sparring.md` (copy of this plan's sparring record).
## Out of scope (named so a lane does not drift into them)
- Any screen in another Wave 2 ledger lane (`home-feed`, `media`, `ai`, `discover-commerce`, `inbox-chat-calls`,
  `health`, `wallet`, `profile-settings-support`, `role-modes`, `sharing-business`, `memory-diary`,
  `journey-autopilot`, `public-auth`) — each is its own plan.
- Admin events / live-rooms / meetups consoles (`src/pages/admin/community/*`) — not in the `events-calendar`
  member-facing lane.
- G1 / G2 / G3 provisioning, EAS / store build pipelines, the ORB voice module — their own plans / owner gates.
- Any web-side change beyond adding an i18n key (DE first) and a `@vitana/core` re-export line.
- Moving any class-B module (runtime-imports `@/integrations/supabase/client.ts`) into `@vitana/core`.
