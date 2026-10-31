# Plan — native-wave2-events-calendar
Author: Kiro, seat `exafyltd`. Repo: `exafyltd/vitana-v1` (native app only — `apps/mobile/**`, `packages/core/**`
via the manifest/closure process, `apps/mobile/parity/ledger.json`, DE-first i18n shards, `docs/validation/**`; no
backend, no gateway change, no migration). Spec: `requirements.md`, `design.md`, `tasks.md`, `lanes/*.md` in this
folder. Program: `docs/programs/native-app/NATIVE-APP-PLAN.md` (VTID-05021), §5 Wave 2.
<!-- plan:begin -->
## Cross-repo sparring
This plan's implementation lives in `exafyltd/vitana-v1` (native app `apps/mobile/**`, `packages/core/**`, the parity
ledger, i18n shards), while the plan PR itself is in `exafyltd/vitana-platform`. Every load-bearing premise the
sparring partner must verify — the 22-row parity-ledger partition for `"lane": "events-calendar"`, the class-A/class-B
closures, `lib/vcal/time.ts` and `liveRoom.ts`, the ERROR-level i18n locale rule and the `src/App.tsx` routes — is a
vitana-v1 file, read through the `spar_refs` (`exafyltd/vitana-v1: main`) declared in `handoff.md`.

## Sparring status
Rounds 1–2 ran blind: `spar_refs` is applied only at `client.create`, never at `client.round`
(`scripts/collab/plan-spar.mjs:333`), so the in-progress round-1 session never acquired vitana-v1 read access
(`responses-2.md`, findings R1-F1 / R1-F4). The spec folder (including `handoff.md` with the `spar_refs` block) is on
this PR HEAD branch, not the pinned base commit — PLAN-SPAR reads it from the plan tree. A fresh session is required
so the partner can verify the frontend premises; this plan-text change sets up the `replan` path (a changed plan on an
escalated, non-infra session creates a new session with `spar_refs` applied). Round 2 confirmed the blocker is purely
mechanical (the session predates `spar_refs` reaching the branch, and `client.round` never forwards `extra_refs` —
`scripts/collab/plan-spar.mjs:291`), not a merits defect: no content finding was raised against the plan, only the
code-access and spec-presence conditions. The branch now carries the spec folder and the merged `extra_refs`
forwarding fix at its base, so the moment the current in-progress session reaches its round cap and escalates
(non-infra), the next run with this changed plan text creates session #2 (`sessions.length` 1 < `MAX_SESSIONS` 2)
with `extra_refs: { exafyltd/vitana-v1: <resolved main SHA> }` applied at `client.create`, giving the partner
read access to verify the 22-row ledger partition, the class-A/class-B closures, `lib/vcal/time.ts`, `liveRoom.ts`,
the ERROR-level i18n locale rule and the `src/App.tsx` routes.
## Goal
Second Wave 2 screen-port batch of the native Maxina app: port the events / meetups / calendar / reminders /
live-rooms cluster — the **22 web destinations the parity ledger assigns to `"lane": "events-calendar"`** — to the
native app (`apps/mobile/`) at 1:1 parity with today's **mobile web** screens (the `useIsMobile()` ≤ 1024 px branch),
built on `@vitana/core` + `@vitana/tokens` + the N2 UI kit (`@vitana/ui`) on the Wave 1 N3 shell, with fixture /
fake-gateway unit tests. Does **not** need G1 planned or built to land the ports; every device-runtime verification
step — the Daily.co live-rooms join in particular — is marked depends-on-owner (G1). No redesign (program §4), no new
web screen, no `App.tsx` route, no registry / manifest / `screens.json` / `exclusions.json` change — only native route
files and parity-row status flips.
## Measured state (worktree = origin/main, parity ledger `apps/mobile/parity/ledger.json` version 2)
- **22 rows** carry `"lane": "events-calendar"`, **all `status: "not_started"`** (14 `screen`, 3 `overlay`, 6
  exclusion `route`, incl. the one `overlay` for `/calendar`); **435 rows total**. Counted with `node -e` over the
  committed ledger (the `--report` CLI needs `typescript`, not installed in this worktree). The 22 rows and their web
  paths are listed in `requirements.md` R0.2–R0.4.
- Web sources verified present with line counts: `src/pages/community/EventsAndMeetups.tsx` (1489),
  `src/pages/community/LiveRooms.tsx` (1073), `src/pages/community/LiveRoomViewer.tsx` (421),
  `src/pages/Calendar.tsx` (552), `src/pages/Reminders.tsx` (66), `src/pages/community/EventGamePage.tsx` (134),
  `src/pages/EventGamePublicLanding.tsx` (162), `src/pages/PublicEventLanding.tsx` (514); dialogs
  `src/components/CreateEventPopup.tsx` (912), `src/components/CreateMeetupPopup.tsx` (593),
  `src/components/EditMeetupPopup.tsx` (857); live-room parts `src/components/liverooms/DailyVideoRoom.tsx` (88),
  `src/components/liverooms/LiveRoomDrawer.tsx` (670), `src/components/events/EventsLiveRooms.tsx` (281); reminder
  parts `src/components/reminders/RemindersPanel.tsx` (425), `src/components/reminders/ReminderInterruptOverlay.tsx`
  (252); calendar subtree `src/components/calendar/vcal/**` (EntryScreen, AddEntrySheet, views, sections, FindTime,
  labels, time, theme, guidance, …) + `src/components/calendar/MobileEventForm.tsx`. Routes at `src/App.tsx:1185-1201`
  (calendar), `:1203-1219` (reminders), `:1242-1260` (events-meetups + live-rooms), `:851-857`/`:953` (public
  event/game landings). (These line counts are an **approximate** scoping snapshot; exact counts are not load-bearing.
  The load-bearing checks are the class-A/class-B determinations below, confirmed at the pinned commit.)
- Wave 1 is on main: N3 shell + resolver route (`apps/mobile/app/(app)/[...path].tsx`, VTID-05186), N2 UI kit
  (`@vitana/ui`, VTID-05176), N1 `@vitana/core`/`@vitana/tokens` (VTID-05183). Ports and conventions in
  `apps/mobile/README.md`; ports at `apps/mobile/src/ports/{core,ui,tokens,env,links,badges,soundscape,orb-slot}.*`,
  resolver `apps/mobile/src/navigation/resolve.ts`. The native app has no production profile;
  `assertNotProduction()` refuses prod/staging hosts.
## Decisions (made by Kiro as planner under the owner's "finish the native apps" instruction; sparring may revise)
1. **Three disjoint lanes by cluster**, partitioning the 22 rows with 0 overlap and 0 orphan (verified against the
   ledger by `web_path` grouping):
   - **`events-meetups` (12 rows)** — the events/meetups hub and its drawers/public landings: `COMM.EVENTS`,
     `COMM.EVENTS_HOT`, `COMM.EVENTS_TODAY`, `COMM.EVENTS_UPCOMING`, `COMM.FEED`, `COMM.OVERVIEW`,
     `OVERLAY.EVENT_DRAWER`, `OVERLAY.MEETUP_DRAWER`, and the 4 exclusion routes `/community/event-game`, `/e/:slug`,
     `/e/game/:slug`, `/pub/events/:id`. Web sources `EventsAndMeetups.tsx`, the three Create/Edit dialogs,
     `EventGamePage.tsx`, `EventGamePublicLanding.tsx`, `PublicEventLanding.tsx`.
   - **`calendar-reminders` (4 rows)** — `CALENDAR.OVERVIEW /calendar`, `REMINDERS.OVERVIEW /reminders`, and the two
     exclusion deep-link routes `/calendar/entry/:entryId`, `/reminders/fire/:fireId`. Web sources `Calendar.tsx`
     (+ the `src/components/calendar/vcal/**` subtree, `MobileEventForm.tsx`), `Reminders.tsx`, `RemindersPanel.tsx`,
     `ReminderInterruptOverlay.tsx`.
   - **`live-rooms` (6 rows)** — `COMM.LIVE_ROOMS` + the 4 tab variants (`?tab=all|live|past|scheduled`) and
     `COMM.LIVE_ROOM_VIEWER /comm/live-rooms/:roomId/view`. Web sources `LiveRooms.tsx`, `LiveRoomViewer.tsx`,
     `DailyVideoRoom.tsx`, `LiveRoomDrawer.tsx`, `EventsLiveRooms.tsx`.
   The three touch disjoint route files and component folders under `apps/mobile/`, build/review independently, and
   each leaves the app buildable. Partition: **12 + 4 + 6 = 22** (`parity-ledger.mjs` matches by exact `shapeOf()`
   (`:60`), not prefix, so e.g. `/comm/live-rooms/:roomId/view` is its own row, never "covered under
   `/comm/live-rooms`"). Each lane flips **only its own** rows `not_started`→`native`; the lane acceptance REQUIRES
   the flip (if the native files exist but the rows stay `not_started`, `--check` passes silently while the ledger
   reports the lane permanently incomplete).
2. **Only pure, IO-free helper modules move into `@vitana/core`; the data-fetching pages, dialogs and hooks do
   NOT.** The screen pages and dialogs runtime-import `@/integrations/supabase/client.ts` — **class-B** confirmed at
   the pinned commit for `src/pages/Calendar.tsx`, `src/pages/community/LiveRooms.tsx`,
   `src/pages/community/LiveRoomViewer.tsx`, `src/components/CreateEventPopup.tsx`,
   `src/components/CreateMeetupPopup.tsx`, `src/components/EditMeetupPopup.tsx`. **A class-B module is NEVER moved into
   `@vitana/core`** — it would make `core-closure.mjs --check` fail (`core-closure.mjs:150`, `m.own !== 'A'`) because
   `supabase/client.ts` pulls `import.meta.env` / `localStorage` / the prod Supabase URL into the closure. Instead
   each lane **re-implements the fetching natively** (native Supabase client + native auth context, the Wave 1
   pattern) and consumes only the pure helpers from core. Candidate pure helpers per lane (final set confirmed by
   `core-closure --write`/`--check` in the lane PR): events → event/meetup label + date helpers; calendar-reminders →
   `src/components/calendar/calendar-entry.ts`, `src/components/calendar/vcal/{time,labels,guidance,theme}.ts`;
   live-rooms → `src/components/liverooms/liveRoomFormat.ts`, `src/components/ui/vcard/adapters/liveRoom.ts`. These
   import only `@/lib/i18n-toast`, `@/lib/locale-format`, `date-fns` and type-only cross-refs; a helper that the
   closure BFS proves reaches a class-B module is re-implemented natively instead, not forced into core (the
   determination is mechanical — `core-closure --check` is the gate, not this list).
3. **Each extracting lane owns its own core re-export files** (distinct `packages/core/src/*.ts` entry files), so the
   lanes' owned source trees stay disjoint. `packages/core/manifest.json`, `packages/core/closure.generated.json` and
   `scripts/native/mobile-ci-paths.generated.json` are **shared-by-line** across the three lanes: each extracting lane
   adds its own manifest lines and, **in the same PR**, runs `node scripts/native/core-closure.mjs --write` and
   commits the regenerated `packages/core/closure.generated.json` + `scripts/native/mobile-ci-paths.generated.json`, so
   `--check` passes. **These two generated files are produced wholesale by `core-closure.mjs`, not appended by hand**,
   so when a second lane lands on main after the first, its PR does **not** text-merge them: it rebases on the updated
   main, re-runs `node scripts/native/core-closure.mjs --write`, and commits the freshly regenerated output (which now
   contains both lanes' closures). `packages/core/manifest.json` entries are append-only and a conflict there is
   resolved by keeping **both** lanes' lines; the two `*.generated.json` files are always resolved by re-running
   `--write` on the merged tree, never by a hand-merge. The serialized fallback in Decision 4 applies if the
   regenerate-on-rebase step cannot keep the three lanes conflict-free in practice.
4. **No hard cross-lane dependency, with a serialized fallback.** The three lanes own disjoint `apps/mobile/`
   subtrees and disjoint core entry files, so all three run in parallel (`depends_on: []`). The only files all three
   touch are the two wholesale-regenerated `*.generated.json` closure files and append-only `manifest.json`, handled
   by the regenerate-on-rebase rule in Decision 3. **Fallback (decided at lane-build if that rule does not keep the
   three conflict-free):** the two non-`events-meetups` lanes take `depends_on: [events-meetups]` so the core
   entries land serialized — `events-meetups` first, then `calendar-reminders` and `live-rooms` rebase on its merged
   closure. That `depends_on` edit is a change to the `lanes/<id>.md` files, which a `_plan` commit may not make, so
   it is not applied here; it is recorded as the named fallback for the lane-build step. If a later finding shows a
   shared native card twin is needed across lanes, the owning lane is named and a `depends_on` added — not assumed now.
5. **No new routes / registry / manifest.** Ports of screens already in `App.tsx` + `screens.json`; a native Expo
   Router file is not an `App.tsx` route, so the "new page needs screens.json/exclusions.json + screen-manifest +
   parity rows" rule does not fire — only parity-row **status** flips (`not_started`→`in_progress`→`native`). The 6
   exclusion routes are ports WITH their own ledger rows (exact `shapeOf` match), flipped by their owning lane.
6. **Device-runtime verification deferred to G1** (owner gate). Lanes land with offline build + fake-gateway unit
   tests green; the Maestro / simulator / screenshot-parity pass is a `next_actor: owner` task recorded in the lane and
   `staging-tests.json`. **The live-rooms Daily.co join (`DailyVideoRoom.tsx` → `@daily-co/*`) cannot be exercised
   offline at all** — its unit tests cover token fetch, room-state mapping, host detection, tab filtering and the
   drawer; the actual video join and the publisher/subscriber flow are explicitly G1-deferred per the live-rooms lane
   and in the plan.
7. **Dates / times MUST use the locale-format helpers** `fmtDate` / `fmtTime` / `fmtDateTime` / `formatDate` (and the
   `formatDistance` family) from `@/lib/locale-format` — never raw `toLocaleDateString`/`toLocaleTimeString`/
   `toLocaleString` and never `date-fns` `format` directly. The repo ESLint rule `i18n/no-raw-locale-call` is
   **ERROR** level. **This is critical for the `calendar-reminders` lane** (dense date/time rendering: entries, FindTime,
   overlap windows, reminder fire times) and also applies to event start/end times and live-room scheduled/"starting
   soon" labels. The pure date helpers extracted to core already route through `fmtTime`/`fmtDate`
   (`vcal/time.ts:6`, `adapters/liveRoom.ts:8`); native twins must keep that routing.
8. **Mobile-web parity, not desktop.** Each native screen mirrors the `useIsMobile()` ≤ 1024 px branch of its source,
   composed through N3/N2, every visual value from `@vitana/tokens`; no web file is touched beyond a DE-first i18n key
   and a `@vitana/core` re-export line. Member-listing / interested-people queries reuse the web query unchanged so the
   test/service-account allowlist exclusion (program NEVER 43–45) is inherited, not re-implemented.
## Lanes (all `ready`, executor kiro; seat → reviewer_seat; `vtid:` filled by CI on convergence)
| Lane | Seat → reviewer | Scope (web destinations) | depends_on |
|---|---|---|---|
| `events-meetups` | exafyltd → hotmail | events/meetups hub `/comm/events-meetups` (+ `?tab=hot\|today\|upcoming\|following`), `COMM.OVERVIEW`, event + meetup drawers, and the 4 public/game exclusion routes `/community/event-game`, `/e/:slug`, `/e/game/:slug`, `/pub/events/:id` (**12 rows**) | — |
| `calendar-reminders` | exafyltd → hotmail | `/calendar` (+ `/calendar/entry/:entryId`), `/reminders` (+ `/reminders/fire/:fireId`) — the calendar overlay + reminders screen and their deep-link routes (**4 rows**); **the date/time locale-helper rule is load-bearing here** | — |
| `live-rooms` | exafyltd → hotmail | `/comm/live-rooms` (+ `?tab=all\|live\|past\|scheduled`) and `/comm/live-rooms/:roomId/view` — the live-rooms list + viewer (Daily.co); device-runtime join is G1-deferred (**6 rows**) | — |
Exact `paths` globs are in each `lanes/<id>.md`; the 22 parity rows partition **12 (events-meetups) + 4
(calendar-reminders) + 6 (live-rooms)** with 0 overlap and 0 orphan. All three run in parallel.
## Test plan
- **Per lane, offline (fixture / fake gateway, no network):** from `apps/mobile/` — `npm run typecheck`, `npm test`
  (jest-expo + RNTL: loaded / empty / error per screen; events tab switch + drawer open/dismiss; calendar
  month/week/day view + entry sheet + reminder fire deep-link; live-rooms tab filter + viewer state + token-fetch
  error; i18n no-raw-text + RTL start/end; **no raw `toLocaleX` / `date-fns format` — locale-format helpers only**;
  React 19 `ReactElement`), `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check`. From the repo root —
  `node scripts/native/parity-ledger.mjs --check` (rows `native`, routes present).
- **Core extraction deliverable (per extracting lane): run `--write` AND commit the generated files, not just
  `--check`.** The PR that adds a lane's `@vitana/core` re-export entries to `packages/core/src/` + `manifest.json`
  MUST also run `node scripts/native/core-closure.mjs --write` and commit the regenerated
  `packages/core/closure.generated.json` and `scripts/native/mobile-ci-paths.generated.json` in the SAME PR, then
  `node scripts/native/core-closure.mjs --check` passes. Without the `--write`+commit, `--check` fails in NATIVE-CI
  with "stale generated file" regardless of whether the modules are class A. A module the closure BFS proves reaches
  a class-B file (`@/integrations/supabase/client.ts`) is re-implemented natively, never added to core.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- **i18n:** 11 locales (ar de en es fr pl pt ru sr tr zh), any new key DE-first (du-form) then mirrored; RTL (`ar`)
  rendered per screen.
- **Deferred to G1 (owner gate, `next_actor: owner`):** Maestro `maestro/<lane>/*.yaml`, iOS simulator + Android
  emulator screenshots at the device sizes, screenshot parity vs the relevant 390×844 **read-only** staging web
  screen; listed in `docs/validation/<VTID>/staging-tests.json` (sign in, navigate, read; network guard aborts every
  non-GET except sign-in; never `vitanaland.com`). **The live-rooms Daily.co video join is fully G1-deferred** — no
  offline test exercises the real join. STAGING-VERIFY is read-only by construction (program §6).
- **No What's New entry** (ports of existing screens). No new routes → no nav-registry change and no new native parity
  row — only status flips.
## Open owner / sparring items (not decided here)
- G1 isolated test environment (program gate) — required before any device-runtime parity check, and the only place
  the live-rooms Daily.co join can be exercised; the deferred tasks stay `next_actor: owner` until it exists.
- macOS minutes / G3 for iOS-on-device screenshots (program STATUS row 8b) — not needed for the JS build.
- Final set of pure helpers each lane extracts to `@vitana/core` — the candidate lists in decision 2 are confirmed
  mechanically by `core-closure --write`/`--check` in each lane PR; a helper proven class-B is re-implemented natively.
<!-- plan:end -->
