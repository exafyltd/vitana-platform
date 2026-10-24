# Tasks — Native Wave 2: Events / Meetups / Calendar / Reminders / Live-rooms screen ports
Three lanes, disjoint `paths`. Design: `design.md` and `requirements.md` in this folder are authoritative — follow
them exactly; anything outside them is a plan change (log it, set `next_actor: claude`). VTIDs are assigned by CI
after PLAN-SPAR converges; do not start a lane before its `vtid:` is set in `lanes/<id>.md`. All commands run from
`apps/mobile/` unless noted; `assertNotProduction()` and the no-production-profile rule make every command offline.
**Dates/times rule (every lane, ERROR-level ESLint `i18n/no-raw-locale-call`):** use `fmtDate` / `fmtTime` /
`fmtDateTime` / `formatDate` (+ the `formatDistance` family) from `@/lib/locale-format` — never raw `toLocaleX` and
never `date-fns` `format` directly.
<!-- lane: events-meetups -->
## Lane `events-meetups` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports (12 ledger rows under `"lane": "events-calendar"`): `COMM.EVENTS /comm/events-meetups`,
`COMM.EVENTS_HOT /comm/events-meetups?tab=hot`, `COMM.EVENTS_TODAY ?tab=today`, `COMM.EVENTS_UPCOMING ?tab=upcoming`,
`COMM.FEED ?tab=following`, `COMM.OVERVIEW ?tab=hot`, `OVERLAY.EVENT_DRAWER`, `OVERLAY.MEETUP_DRAWER`, and the 4
exclusion routes `/community/event-game`, `/e/:slug`, `/e/game/:slug`, `/pub/events/:id`. depends_on: none. Web
sources `src/pages/community/EventsAndMeetups.tsx` (1489; route `src/App.tsx:1242-1249`),
`src/components/CreateEventPopup.tsx` (912, class-B), `src/components/CreateMeetupPopup.tsx` (593, class-B),
`src/components/EditMeetupPopup.tsx` (857, class-B), `src/pages/community/EventGamePage.tsx` (134; route
`src/App.tsx:953`), `src/pages/EventGamePublicLanding.tsx` (162), `src/pages/PublicEventLanding.tsx` (514; routes
`src/App.tsx:851-857`).
- [ ] 1. Core re-exports: add the **pure** event/meetup label + date-format helper modules this lane's screens use to
  `@vitana/core` via the manifest + a re-export in `packages/core/src/**`, then `node scripts/native/core-closure.mjs
  --write`. The data-fetching page/dialogs (`EventsAndMeetups.tsx`, the three Create/Edit popups — all class-B) are
  **NOT** moved into core; the fetching is re-implemented natively (native Supabase client + native auth context),
  reusing the web query shapes unchanged so the test/service-account allowlist exclusion (program NEVER 43–45) is
  inherited. Any helper the closure BFS proves reaches `@/integrations/supabase/client.ts` is re-implemented natively,
  not added to core.
  Files: `packages/core/manifest.json`, `packages/core/src/**`, `packages/core/closure.generated.json`,
  `scripts/native/mobile-ci-paths.generated.json`.
  Verify (repo root): `node scripts/native/core-closure.mjs --check` passes; `apps/mobile` → `npm run typecheck` green.
- [ ] 2. Events / meetups hub: `apps/mobile/app/(app)/comm/events-meetups/index.tsx` +
  `apps/mobile/src/screens/events/EventsMeetupsScreen.tsx` — twin of the mobile-web branch of `EventsAndMeetups.tsx`
  on the N3 shell: the hot / today / upcoming / following tabs via the `tab` search param, event/meetup card list in a
  `FlatList` of `VCard`s, pull-to-refresh, infinite scroll. All event start/end times via `fmtDateTime`/`fmtDate`
  (locale-format), never raw `toLocaleX`. `COMM.OVERVIEW` resolves to the same screen (it is `?tab=hot`).
  Files: `apps/mobile/app/(app)/comm/events-meetups/**`, `apps/mobile/src/screens/events/**`.
  Verify: `npm test` (the events unit tests below) + `npm run typecheck` green.
- [ ] 3. Event + meetup drawers (`OVERLAY.EVENT_DRAWER`, `OVERLAY.MEETUP_DRAWER`): native bottom-sheet twins opened
  from a card on `/comm/events-meetups`, with the create/edit affordances (twins of `CreateEventPopup.tsx`,
  `CreateMeetupPopup.tsx`, `EditMeetupPopup.tsx`) — mobile-web branch only; writes go through the native client.
  Files: `apps/mobile/app/(app)/comm/events-meetups/**`, `apps/mobile/src/screens/events/**`.
  Verify: `npm test` — drawer open/dismiss + form state tests; `npm run typecheck` green.
- [ ] 4. Public / game landing routes (`/community/event-game`, `/e/:slug`, `/e/game/:slug`, `/pub/events/:id`): native
  route files resolving to the event-game and public-event-landing screen twins (`EventGamePage.tsx`,
  `EventGamePublicLanding.tsx`, `PublicEventLanding.tsx`), the deep-link targets from shares and pushes.
  Files: `apps/mobile/app/(app)/community/event-game.tsx`, `apps/mobile/app/(app)/e/**`,
  `apps/mobile/app/(app)/pub/events/**`, `apps/mobile/src/screens/events/**`.
  Verify: `npm test` — each route resolves to the right screen; `npm run typecheck` green.
- [ ] 5. i18n + RTL: user-visible strings from the web shards; any genuinely new key added to `src/i18n/de/*.json`
  first, then the other ten (ar de en es fr pl pt ru sr tr zh); render under `ar` with start/end only; no hardcoded
  text, no physical `left`/`right`; all dates/times via locale-format.
  Files: `src/i18n/*/eventsNative.json` (DE first), `apps/mobile/src/screens/events/**`.
  Verify: `npm run typecheck`; `npm test` — no-raw-text, no-physical-direction, no-raw-locale-call tests pass.
- [ ] 6. Unit tests (fake gateway / fixtures, no network): list loaded / empty / error per tab; tab switch; card →
  drawer open/dismiss; create/edit form state; each public/game route resolves; dates render via locale-format (assert
  no raw `toLocaleX`). React 19 `ReactElement`.
  Files: `apps/mobile/src/screens/events/__tests__/**`, `apps/mobile/app/(app)/comm/events-meetups/__tests__/**`.
  Verify: `npm test` green; `APP_PROFILE=development npm run bundle` and
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 7. Flip the lane's 12 parity rows to `native` and verify: `node scripts/native/parity-ledger.mjs --sync` (status
  edited by hand to `native`), then `--check`.
  Files: `apps/mobile/parity/ledger.json` (events-meetups rows only), `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 8. **(depends-on-owner / G1 — `next_actor: owner`)** Device-runtime parity: Maestro journey(s)
  `apps/mobile/maestro/events/*.yaml`, iOS simulator + Android emulator screenshots at the device sizes, screenshot
  parity vs the 390×844 read-only staging web `/comm/events-meetups`. Blocked until G1 (and macOS minutes / G3 for iOS).
  Files: `apps/mobile/maestro/events/**`, `docs/validation/<VTID>/staging-tests.json`.
  Verify: on G1 only; recorded in the lane log, not run in CI.
- [ ] 9. PR: branch `kiro/native-wave2-events-calendar/events-meetups`, title
  `VTID-xxxxx (native-wave2-events-calendar/events-meetups): native events / meetups port`, body names the Kiro
  session id, Summary / Decisions taken / Tests / Handoff. Commit trailers `Collab-Session: <kiro id>`,
  `Collab-Lane: native-wave2-events-calendar/events-meetups`. Lane → `in-review`, `next_actor: kiro` (reviewer seat
  `hotmail`). Never merge, deploy or write to a live system (protocol §7a).
<!-- lane: calendar-reminders -->
## Lane `calendar-reminders` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports (4 ledger rows): `CALENDAR.OVERVIEW /calendar`, `REMINDERS.OVERVIEW /reminders`, and the exclusion deep-link
routes `/calendar/entry/:entryId` and `/reminders/fire/:fireId`. depends_on: none. Web sources `src/pages/Calendar.tsx`
(552, class-B; routes `src/App.tsx:1185-1201`), the calendar subtree `src/components/calendar/vcal/**`
(EntryScreen, AddEntrySheet, views, sections, FindTime, OverlapWarning, labels, time, theme, guidance) +
`src/components/calendar/MobileEventForm.tsx`, `src/pages/Reminders.tsx` (66; routes `src/App.tsx:1203-1219`),
`src/components/reminders/RemindersPanel.tsx` (425), `src/components/reminders/ReminderInterruptOverlay.tsx` (252).
**The date/time locale-helper rule is load-bearing here** (dense date/time rendering).
- [ ] 1. Core re-exports: add the **pure** calendar helper modules `src/components/calendar/calendar-entry.ts`,
  `src/components/calendar/vcal/{time,labels,guidance,theme}.ts` (they import only `@/lib/i18n-toast`,
  `@/lib/locale-format`, `date-fns` and type-only `calendar-window-client` refs — class-A at the pinned commit) to
  `@vitana/core` via the manifest + a re-export in `packages/core/src/**`, then `node scripts/native/core-closure.mjs
  --write`. `Calendar.tsx` itself is class-B (runtime Supabase) and is re-implemented natively. A helper the closure
  BFS proves reaches `@/integrations/supabase/client.ts` is re-implemented natively, not added to core.
  Files: `packages/core/manifest.json`, `packages/core/src/**`, `packages/core/closure.generated.json`,
  `scripts/native/mobile-ci-paths.generated.json`.
  Verify (repo root): `node scripts/native/core-closure.mjs --check` passes; `apps/mobile` → `npm run typecheck` green.
- [ ] 2. Calendar screen: `apps/mobile/app/(app)/calendar/index.tsx` + `apps/mobile/src/screens/calendar/CalendarScreen.tsx`
  — twin of the mobile-web branch of `Calendar.tsx` on the N3 shell: month/week/day views, entry list, the add-entry
  sheet (twin of `vcal/AddEntrySheet.tsx` + `MobileEventForm.tsx`), FindTime / overlap-warning behaviour. **Every
  date and time rendered via `fmtDate`/`fmtTime`/`fmtDateTime`/`formatDate` from `@/lib/locale-format`** (the extracted
  `vcal/time.ts`/`labels.ts` already route through these) — never raw `toLocaleX`, never `date-fns format`.
  Files: `apps/mobile/app/(app)/calendar/**`, `apps/mobile/src/screens/calendar/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 3. Calendar entry deep-link `apps/mobile/app/(app)/calendar/entry/[entryId].tsx` (twin of `vcal/EntryScreen.tsx`,
  opened by `/calendar/entry/:entryId`); back-navigation (gesture + button).
  Files: `apps/mobile/app/(app)/calendar/entry/**`, `apps/mobile/src/screens/calendar/**`.
  Verify: `npm test` — deep-link resolves to the entry screen; `npm run typecheck` green.
- [ ] 4. Reminders screen `apps/mobile/app/(app)/reminders/index.tsx` + `apps/mobile/src/screens/calendar/RemindersScreen.tsx`
  (twin of `Reminders.tsx` + `RemindersPanel.tsx`) and the fire deep-link `apps/mobile/app/(app)/reminders/fire/[fireId].tsx`
  (web `/reminders/fire/:fireId`, the `ReminderInterruptOverlay` target — renders the reminders screen and surfaces the
  interrupt overlay). Reminder fire times via locale-format.
  Files: `apps/mobile/app/(app)/reminders/**`, `apps/mobile/src/screens/calendar/**`.
  Verify: `npm test` — reminders list + fire deep-link resolve; `npm run typecheck` green.
- [ ] 5. i18n + RTL (as events-meetups task 5) for the calendar + reminders screens; new keys DE-first then the other
  ten; all dates/times via locale-format.
  Files: `src/i18n/*/calendarNative.json` (DE first), `apps/mobile/src/screens/calendar/**`.
  Verify: `npm run typecheck`; `npm test` — no-raw-text / no-physical-direction / no-raw-locale-call tests pass.
- [ ] 6. Unit tests (fake gateway / fixtures): calendar loaded / empty / error; view switch (month/week/day); add-entry
  sheet open + validation; entry deep-link resolves + back; reminders list loaded / empty; fire deep-link resolves and
  shows the interrupt overlay; **every date/time assertion checks locale-format output, not raw `toLocaleX`**. React 19
  `ReactElement`.
  Files: `apps/mobile/src/screens/calendar/__tests__/**`, `apps/mobile/app/(app)/calendar/__tests__/**`,
  `apps/mobile/app/(app)/reminders/__tests__/**`.
  Verify: `npm test`; `APP_PROFILE=development npm run bundle`;
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 7. Flip the lane's 4 parity rows to `native`; `--sync` then `--check`.
  Files: `apps/mobile/parity/ledger.json` (calendar-reminders rows only),
  `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 8. **(depends-on-owner / G1 — `next_actor: owner`)** Maestro `apps/mobile/maestro/calendar/*.yaml` +
  sim/emulator screenshots + parity vs 390×844 staging `/calendar` and `/reminders`. Blocked until G1 (+ macOS/G3 for
  iOS).
  Files: `apps/mobile/maestro/calendar/**`, `docs/validation/<VTID>/staging-tests.json`.
- [ ] 9. PR: branch `kiro/native-wave2-events-calendar/calendar-reminders`, title
  `VTID-xxxxx (native-wave2-events-calendar/calendar-reminders): native calendar / reminders port`; trailers
  `Collab-Session`, `Collab-Lane: native-wave2-events-calendar/calendar-reminders`; lane → `in-review`,
  `next_actor: kiro`. No merge/deploy/live write.
<!-- lane: live-rooms -->
## Lane `live-rooms` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports (6 ledger rows): `COMM.LIVE_ROOMS /comm/live-rooms`, `COMM.LIVE_ROOMS_ALL ?tab=all`,
`COMM.LIVE_ROOMS_LIVE ?tab=live`, `COMM.LIVE_ROOMS_PAST ?tab=past`, `COMM.LIVE_ROOMS_SCHEDULED ?tab=scheduled`,
`COMM.LIVE_ROOM_VIEWER /comm/live-rooms/:roomId/view`. depends_on: none. Web sources `src/pages/community/LiveRooms.tsx`
(1073, class-B; route `src/App.tsx:1253-1255`), `src/pages/community/LiveRoomViewer.tsx` (421, class-B; route
`src/App.tsx:1258-1260`), `src/components/liverooms/DailyVideoRoom.tsx` (88, Daily.co), `src/components/liverooms/LiveRoomDrawer.tsx`
(670), `src/components/events/EventsLiveRooms.tsx` (281).
- [ ] 1. Core re-exports: add the **pure** live-room helper modules `src/components/liverooms/liveRoomFormat.ts` and
  `src/components/ui/vcard/adapters/liveRoom.ts` (import only `@/lib/i18n-toast`, `@/lib/locale-format`, type-only
  `LiveRoomCard` ref — class-A at the pinned commit) to `@vitana/core` via the manifest + a re-export in
  `packages/core/src/**`, then `node scripts/native/core-closure.mjs --write`. `LiveRooms.tsx`/`LiveRoomViewer.tsx`
  are class-B (runtime Supabase) and are re-implemented natively. A helper the closure BFS proves reaches
  `@/integrations/supabase/client.ts` is re-implemented natively, not added to core.
  Files: `packages/core/manifest.json`, `packages/core/src/**`, `packages/core/closure.generated.json`,
  `scripts/native/mobile-ci-paths.generated.json`.
  Verify (repo root): `node scripts/native/core-closure.mjs --check` passes; `apps/mobile` → `npm run typecheck` green.
- [ ] 2. Live-rooms list `apps/mobile/app/(app)/comm/live-rooms/index.tsx` +
  `apps/mobile/src/screens/liverooms/LiveRoomsScreen.tsx` — twin of the mobile-web branch of `LiveRooms.tsx` on the
  N3 shell: the all / live / past / scheduled tabs via the `tab` search param, live-room card list, the live-room
  drawer (twin of `LiveRoomDrawer.tsx`) with interested-people. Scheduled / "starting soon" labels via locale-format.
  Files: `apps/mobile/app/(app)/comm/live-rooms/index.tsx`, `apps/mobile/src/screens/liverooms/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 3. Live-room viewer `apps/mobile/app/(app)/comm/live-rooms/[roomId]/view.tsx` +
  `apps/mobile/src/screens/liverooms/LiveRoomViewerScreen.tsx` — twin of `LiveRoomViewer.tsx`: host detection, room
  state, the Daily.co join surface (twin of `DailyVideoRoom.tsx` using `@daily-co/react-native-daily-js` or the N-kit
  wrapper). **The actual video join / publisher / subscriber flow is NOT exercisable offline — it is G1-deferred
  (task 8).** The offline unit tests cover token fetch, room-state mapping, host detection and the pre-join UI only.
  Files: `apps/mobile/app/(app)/comm/live-rooms/[roomId]/**`, `apps/mobile/src/screens/liverooms/**`.
  Verify: `npm test` (token fetch / room-state / host-detection, non-network) + `npm run typecheck` green.
- [ ] 4. i18n + RTL (as events-meetups task 5) for the live-rooms list + viewer; new keys DE-first then the other ten;
  schedule/time labels via locale-format.
  Files: `src/i18n/*/liveRoomsNative.json` (DE first), `apps/mobile/src/screens/liverooms/**`.
  Verify: `npm run typecheck`; `npm test` — no-raw-text / no-physical-direction / no-raw-locale-call tests pass.
- [ ] 5. Unit tests (fake gateway / fixtures, no network): list loaded / empty / error per tab; tab filter
  (all/live/past/scheduled); drawer open/dismiss + interested-people; viewer room-state mapping; token-fetch error;
  host-detection; dates via locale-format. **No test performs a real Daily.co join** (deferred to G1). React 19
  `ReactElement`.
  Files: `apps/mobile/src/screens/liverooms/__tests__/**`, `apps/mobile/app/(app)/comm/live-rooms/__tests__/**`.
  Verify: `npm test`; `APP_PROFILE=development npm run bundle`;
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 6. Flip the lane's 6 parity rows to `native`; `--sync` then `--check`.
  Files: `apps/mobile/parity/ledger.json` (live-rooms rows only), `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 7. **(depends-on-owner / G1 — `next_actor: owner`)** Device-runtime parity **and the Daily.co video join**:
  Maestro `apps/mobile/maestro/liverooms/*.yaml` + sim/emulator screenshots + a real live-room join on a device +
  parity vs the 390×844 read-only staging `/comm/live-rooms` and `/comm/live-rooms/:roomId/view`. Blocked until G1
  (+ macOS/G3 for iOS); the video join has no offline substitute.
  Files: `apps/mobile/maestro/liverooms/**`, `docs/validation/<VTID>/staging-tests.json`.
- [ ] 8. PR: branch `kiro/native-wave2-events-calendar/live-rooms`, title
  `VTID-xxxxx (native-wave2-events-calendar/live-rooms): native live-rooms port`; trailers `Collab-Session`,
  `Collab-Lane: native-wave2-events-calendar/live-rooms`; lane → `in-review`, `next_actor: kiro`. No merge/deploy/live
  write.
## Acceptance (every lane; the reviewer seat checks these)
- Requirements R1–R6 met for the lane's screens; mobile-web parity, N2/N3 composition, `@vitana/core`-only bridge.
- `npm run typecheck`, `npm test`, `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green; `node scripts/native/parity-ledger.mjs --check`
  green with the lane's rows `native`; `node scripts/native/core-closure.mjs --check` green.
- 11 locales, DE-first new keys, RTL covered; no hardcoded user-visible text; no physical `left`/`right`; **every
  date/time via `@/lib/locale-format`, no raw `toLocaleX` / `date-fns format`** (ESLint `i18n/no-raw-locale-call`).
- No class-B module (runtime-imports `@/integrations/supabase/client.ts`) moved into `@vitana/core`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** and **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (read-only) and `plan-sparring.md`.
- Device-runtime parity (the last task) is deferred to G1 as `next_actor: owner`; not a merge blocker for the port,
  recorded in the lane log and `staging-tests.json`. The live-rooms Daily.co join is fully G1-deferred.
- Never: VTID allocation, merge/approve, workflow dispatch, deploy, Supabase/AWS writes, or any test against
  production (protocol §7a; program §6).
