# Design — Native Wave 2: Events / Meetups / Calendar / Reminders / Live-rooms screen ports (native-wave2-events-calendar)
How the three lanes port the `events-calendar` ledger cluster to native. Follows
`docs/programs/native-app/NATIVE-APP-PLAN.md` §3 (architecture) and §4 (parity method), the N3 shell and N2 UI kit
already on main, and `apps/mobile/README.md`. Nothing here changes the program plan or the design contract.
## 1. Where native screens live and how they resolve
Wave 1 N3 (VTID-05186) built the shell and a resolver route: `apps/mobile/app/(app)/[...path].tsx` renders every
ledger destination that is not yet native as "Unported", admin as the web console, unknown as not-found. Porting a
screen means **adding its own Expo Router file under `apps/mobile/app/`** whose route path equals the web path, so the
resolver no longer catches it, the push `data.url` / universal link / ORB directive resolve the same, and the parity
row can go `native` (`scripts/native/parity-ledger.mjs` `fileToRoute()` maps `app/(app)/foo/[id].tsx` → `/foo/:id`).
Route-file plan (Expo Router, paths = web paths):
| Lane | Native route file(s) under `apps/mobile/app/` | Web path(s) |
|---|---|---|
| `events-meetups` | `(app)/comm/events-meetups/index.tsx` (tabs `hot`/`today`/`upcoming`/`following` via search param; drawers are sheet state on the same screen), `(app)/community/event-game.tsx`, `(app)/e/[slug].tsx`, `(app)/e/game/[slug].tsx`, `(app)/pub/events/[id].tsx` | `/comm/events-meetups`, `/comm/events-meetups?tab=…`, `/community/event-game`, `/e/:slug`, `/e/game/:slug`, `/pub/events/:id` |
| `calendar-reminders` | `(app)/calendar/index.tsx`, `(app)/calendar/entry/[entryId].tsx`, `(app)/reminders/index.tsx`, `(app)/reminders/fire/[fireId].tsx` | `/calendar`, `/calendar/entry/:entryId`, `/reminders`, `/reminders/fire/:fireId` |
| `live-rooms` | `(app)/comm/live-rooms/index.tsx` (tabs `all`/`live`/`past`/`scheduled` via search param), `(app)/comm/live-rooms/[roomId]/view.tsx` | `/comm/live-rooms`, `/comm/live-rooms?tab=…`, `/comm/live-rooms/:roomId/view` |
Query-string variants (`?tab=`) are the **same route file** reading the search param, exactly as the web screen reads
`useSearchParams()` — they are distinct ledger rows but not distinct files, so they do not overlap across lanes. The
ledger's shape-matching (`shapeOf`, query dropped) is satisfied by the single file; the drawer overlays
(`OVERLAY.EVENT_DRAWER`, `OVERLAY.MEETUP_DRAWER`, `CALENDAR.OVERVIEW` overlay) are sheet/overlay state on the host
screen, not separate route files, and their rows flip with the host.
## 2. Screen source: the N2/N3 structure, not the web DOM
Each lane re-implements the **mobile web** branch of its source screen with React Native primitives:
- Imports go through ports only: `@vitana/core/*` (pure helpers, query keys, types), `@vitana/ui` (UI kit),
  `@vitana/tokens` (visual values), `src/ports/*` from the shell. No `@/…` web import (ESLint-banned in app code).
- The web→native prop map (`apps/mobile/README.md`) is mechanical: `onClick`→`onPress`, `className`→`style`,
  shadcn `Card`→`VCard`/`Panel`, `Dialog`/`Sheet`/`ResponsiveDialog`→the kit's modal / bottom sheet,
  `toast`/`notify*`→`@vitana/ui`/`@vitana/ui/sonner`, list/scroll→`FlatList`/`ScrollView`.
- **Dates/times go through `@/lib/locale-format`** (`fmtDate`/`fmtTime`/`fmtDateTime`/`formatDate`), never raw
  `toLocaleX` / `date-fns format` — the extracted pure helpers (`vcal/time.ts`, `vcal/labels.ts`,
  `adapters/liveRoom.ts`) already route through these and the native twins keep that routing.
### 2a. The class-A / class-B split (the hard constraint of this cluster)
Unlike the home-feed cluster (whose compose/rank modules were pure), the events-calendar **screen pages and dialogs
are class-B**: `src/pages/Calendar.tsx`, `src/pages/community/LiveRooms.tsx`, `src/pages/community/LiveRoomViewer.tsx`,
`src/components/CreateEventPopup.tsx`, `src/components/CreateMeetupPopup.tsx`, `src/components/EditMeetupPopup.tsx` all
runtime-import `@/integrations/supabase/client.ts`. **None of them is moved into `@vitana/core`** — the closure gate
(`core-closure.mjs:150`, `m.own !== 'A'`) fails if a class-B file is reachable, because `supabase/client.ts` pulls
`import.meta.env` / `localStorage` / the prod Supabase URL into the closure. The lanes therefore **re-implement the
data fetching natively** (native Supabase client + native auth context, the Wave 1 pattern) and extract only the pure,
IO-free helpers. Candidate pure helpers (final set confirmed mechanically by `core-closure --write`/`--check` in each
lane PR):
- `events-meetups`: event/meetup label + date-format helpers (confirm each is class-A).
- `calendar-reminders`: `src/components/calendar/calendar-entry.ts` (no imports), `src/components/calendar/vcal/time.ts`
  (imports `date-fns`, `@/lib/locale-format`, `@/lib/i18n-toast`, type-only `calendar-window-client`),
  `vcal/labels.ts`, `vcal/guidance.ts`, `vcal/theme.ts`.
- `live-rooms`: `src/components/liverooms/liveRoomFormat.ts` (imports only `@/lib/i18n-toast`),
  `src/components/ui/vcard/adapters/liveRoom.ts` (imports `@/lib/i18n-toast`, `@/lib/locale-format`, type-only
  `LiveRoomCard`).
`@/lib/i18n-toast` and `@/lib/locale-format` are themselves the reused web helpers; whether they are class-A is the
closure gate's call. If the BFS proves a candidate reaches a class-B module, that candidate is re-implemented natively
instead — the determination is mechanical, not asserted here.
### 2b. events-meetups lane specifics
`EventsAndMeetups.tsx` (1489 lines) is the hub with the hot/today/upcoming/following tabs and the event/meetup card
grid; the event and meetup drawers (create/edit via `CreateEventPopup`/`CreateMeetupPopup`/`EditMeetupPopup`) are
native bottom sheets on the same screen. The 4 exclusion routes are leaf landing screens: `/community/event-game`
(authenticated, `EventGamePage.tsx`), `/e/:slug` and `/pub/events/:id` (`PublicEventLanding.tsx`, the share/ticket
deep-links), `/e/game/:slug` (`EventGamePublicLanding.tsx`, the no-auth-wall game landing). Writes go through the
native Supabase client; the member/attendee queries reuse the web query shapes so the test/service-account allowlist
exclusion (program NEVER 43–45) is inherited, not re-implemented.
### 2c. calendar-reminders lane specifics
`Calendar.tsx` (552, class-B) composes the `vcal/**` subtree: month/week/day `views.tsx`, `sections.tsx`,
`EntryScreen.tsx` (the `/calendar/entry/:entryId` deep-link target), `AddEntrySheet.tsx` + `MobileEventForm.tsx`,
`FindTime.tsx`, `OverlapWarning.tsx`/`useOverlap.ts`. `Reminders.tsx` (66) is a thin shell around
`RemindersPanel.tsx` (425); `/reminders/fire/:fireId` renders the reminders screen and surfaces
`ReminderInterruptOverlay.tsx` (252). **Every date/time on this lane is rendered via `@/lib/locale-format`** — this is
the densest date/time surface in the cluster and the load-bearing instance of R2.5. The pure calendar helpers move to
core; `Calendar.tsx` itself is re-implemented natively.
### 2d. live-rooms lane specifics
`LiveRooms.tsx` (1073, class-B) is the list with all/live/past/scheduled tabs and the live-room drawer
(`LiveRoomDrawer.tsx`, interested-people sheet). `LiveRoomViewer.tsx` (421, class-B) is the viewer with host
detection, room state and the Daily.co join surface `DailyVideoRoom.tsx` (→ `@daily-co/*`). **The actual video join /
publisher / subscriber flow cannot run offline** — the offline unit tests cover token fetch, room-state mapping, host
detection, tab filtering and the pre-join UI only; the real join is fully G1-deferred (task 7). `expo-video` /
`expo-image` map per the program library map. Scheduled / "starting soon" labels via locale-format.
## 3. Disjointness (no overlap, no orphan)
- **Ledger rows:** the 22 `events-calendar` rows partition cleanly — `events-meetups` 12 (COMM.EVENTS, COMM.EVENTS_HOT,
  COMM.EVENTS_TODAY, COMM.EVENTS_UPCOMING, COMM.FEED, COMM.OVERVIEW, OVERLAY.EVENT_DRAWER, OVERLAY.MEETUP_DRAWER,
  /community/event-game, /e/:slug, /e/game/:slug, /pub/events/:id), `calendar-reminders` 4 (CALENDAR.OVERVIEW,
  REMINDERS.OVERVIEW, /calendar/entry/:entryId, /reminders/fire/:fireId), `live-rooms` 6 (COMM.LIVE_ROOMS,
  COMM.LIVE_ROOMS_ALL, COMM.LIVE_ROOMS_LIVE, COMM.LIVE_ROOMS_PAST, COMM.LIVE_ROOMS_SCHEDULED, COMM.LIVE_ROOM_VIEWER).
  12 + 4 + 6 = 22. Each row named explicitly in the lane file.
- **Native files:** each lane owns a disjoint subtree of `apps/mobile/app/` and `apps/mobile/src/screens/` (one folder
  per lane: `src/screens/events/`, `src/screens/calendar/`, `src/screens/liverooms/`). No file is in two lanes.
- **Tests:** each lane owns `apps/mobile/src/screens/<lane>/__tests__/**` (+ `apps/mobile/tests/<cluster>/**`) and its
  `docs/validation/<VTID>/` folder.
- **Shared, by-row-not-by-file:** `apps/mobile/parity/ledger.json` (each lane edits only its own rows),
  `packages/core/manifest.json` + `packages/core/closure.generated.json` + `packages/core/src/**` +
  `scripts/native/mobile-ci-paths.generated.json` (each lane adds only its own distinct re-export entry files and the
  generated files regenerate per PR), `apps/mobile/src/ports/**` + `apps/mobile/src/navigation/resolve.ts` (native
  infra, touched only if a port/resolver gap is found), and the DE-first i18n shards (each lane adds only its screens'
  keys). These are listed in each lane's `paths`.
## 4. Decisions (made by Kiro as planner; sparring may revise)
1. **Three lanes, not one.** The prompt asks for disjoint lanes by cluster. The natural split is events/meetups
   (+ public/game landings), calendar/reminders, and live-rooms (Daily.co). Rationale: the three clusters touch
   disjoint route files and components, can be built and reviewed independently, and each leaves the app buildable.
2. **Class-B screens are re-implemented natively, never moved into `@vitana/core`.** Every screen page and dialog in
   this cluster runtime-imports the Supabase client; forcing them into core breaks the closure gate. Only pure helpers
   move. This is the key difference from the home-feed cluster and the single biggest correctness constraint here.
3. **Each extracting lane owns its own distinct core re-export files**, so the lanes' owned source trees stay disjoint;
   `manifest.json` / `closure.generated.json` / `mobile-ci-paths.generated.json` are shared-by-line and each lane runs
   `core-closure --write` + commits the generated files in its own PR (conflicts kept both ways).
4. **No hard cross-lane dependency** (`depends_on: []` on all three): disjoint native subtrees and disjoint core
   entry files. If sparring shows a shared native card twin is needed across lanes, the owning lane is named and a
   `depends_on` added — not assumed now.
5. **No new routes / registry / manifest.** Ports of screens already in `App.tsx` and `screens.json`; a native route
   file is not an `App.tsx` route, so only parity-row **status** flips — nothing in `src/navigation/registry/`.
6. **Runtime verification deferred to G1** (owner gate). Lanes land with offline build + fake-gateway unit tests
   green; simulator/Maestro/screenshot-parity is `next_actor: owner`. **The live-rooms Daily.co join has no offline
   test at all and is fully G1-deferred.**
7. **Dates/times via `@/lib/locale-format` only** (R2.5), load-bearing on `calendar-reminders`; the native twins keep
   the routing the extracted helpers already use.
## 5. Test design (per lane)
- **Unit (jest-expo + RNTL, fake gateway):** each screen renders its loaded state from fixture data, its empty state,
  its error state. events-meetups: per-tab list + tab switch, card→drawer open/dismiss, create/edit form state, each
  public/game route resolves. calendar-reminders: month/week/day view switch, add-entry sheet + validation, entry
  deep-link + back, reminders list, fire deep-link + interrupt overlay, **date/time assertions check locale-format
  output not raw `toLocaleX`**. live-rooms: per-tab filter, drawer + interested-people, viewer room-state mapping,
  token-fetch error, host detection — **no real Daily.co join**. No network — the gateway/core hooks are mocked with
  fixtures.
- **i18n/RTL/dates:** a test asserts no hardcoded user-visible string and no physical `left`/`right`; renders one
  screen under `ar` (RTL) and asserts start/end; the ESLint `i18n/no-raw-locale-call` rule catches raw date calls.
- **Typecheck/bundle/deps:** `npm run typecheck`, `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` from `apps/mobile/`.
- **Parity + closure:** `node scripts/native/parity-ledger.mjs --check` and `node scripts/native/core-closure.mjs
  --check` from the repo root.
- **Deferred (G1, `next_actor: owner`):** Maestro journeys `maestro/<lane>/*.yaml`, iOS simulator + Android emulator
  screenshots, screenshot parity vs the 390×844 read-only staging web screen, and (live-rooms) a real Daily.co join —
  listed in `docs/validation/<VTID>/staging-tests.json`.
## 6. Open items for the owner / sparring
- G1 isolated test environment (program gate) is required before any device-runtime parity check, and is the only
  place the live-rooms Daily.co join can be exercised; until then the deferred tasks stay `next_actor: owner`.
- Final set of pure helpers each lane extracts to `@vitana/core` — confirmed mechanically by `core-closure` in each
  lane PR.
- macOS minutes / G3 for iOS-on-device screenshots (program STATUS row 8b) — not needed for the JS build.
