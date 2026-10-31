---
lane: events-meetups
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(app)/comm/events-meetups/**
  - apps/mobile/app/(app)/community/event-game.tsx
  - apps/mobile/app/(app)/e/**
  - apps/mobile/app/(app)/pub/events/**
  - apps/mobile/src/screens/events/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/maestro/events/**
  - apps/mobile/tests/events/**
  - packages/core/manifest.json
  - packages/core/closure.generated.json
  - packages/core/src/**
  - scripts/native/mobile-ci-paths.generated.json
  - apps/mobile/parity/ledger.json
  - src/i18n/*/eventsNative.json
  - docs/validation/**
updated: 2026-10-21T20:30Z
---
# Events / meetups port — `/comm/events-meetups` (+ tabs, drawers) + the public / game landing routes
Plan: `.kiro/specs/native-wave2-events-calendar/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: events-meetups -->` (tasks 1–9) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not
start before `vtid:` is set here. depends_on: none — runs in parallel with `calendar-reminders` and `live-rooms`.
**Measured on the worktree (= origin/main):** 12 ledger rows under `"lane": "events-calendar"` for this lane, all
`not_started` — `COMM.EVENTS /comm/events-meetups`, `COMM.EVENTS_HOT ?tab=hot`, `COMM.EVENTS_TODAY ?tab=today`,
`COMM.EVENTS_UPCOMING ?tab=upcoming`, `COMM.FEED ?tab=following`, `COMM.OVERVIEW ?tab=hot`, overlays
`OVERLAY.EVENT_DRAWER` and `OVERLAY.MEETUP_DRAWER`, and the 4 exclusion routes `/community/event-game`, `/e/:slug`,
`/e/game/:slug`, `/pub/events/:id`. Web sources `src/pages/community/EventsAndMeetups.tsx` (1489 lines; route
`src/App.tsx:1242-1249`), `src/components/CreateEventPopup.tsx` (912, **class-B**),
`src/components/CreateMeetupPopup.tsx` (593, **class-B**), `src/components/EditMeetupPopup.tsx` (857, **class-B**),
`src/pages/community/EventGamePage.tsx` (134; route `src/App.tsx:953`), `src/pages/EventGamePublicLanding.tsx` (162),
`src/pages/PublicEventLanding.tsx` (514; routes `src/App.tsx:851-857`).
**Goal.** Port the events / meetups hub and its drawers and public/game landing routes to native on the N3 shell at
1:1 mobile-web parity: the hot/today/upcoming/following tabs via the `tab` search param, an event/meetup card list in
a `FlatList` of `VCard`s with pull-to-refresh and infinite scroll, native event + meetup drawers with create/edit, and
the 4 public/game deep-link routes. Event start/end times via `@/lib/locale-format` (no raw `toLocaleX`). The
data-fetching page and dialogs are class-B (runtime Supabase) and are re-implemented natively; only pure event/meetup
label + date helpers move into `@vitana/core` (task 1). Flips the 12 parity rows to `native`.
**Acceptance (the reviewer seat checks these):**
- Requirements R1–R6 for the events/meetups surfaces; mobile-web parity; `@vitana/core`-only web bridge; no class-B
  module moved into core.
- `npm run typecheck`, `npm test` (list loaded/empty/error per tab; tab switch; card→drawer open/dismiss; create/edit
  form state; public/game routes resolve; dates via locale-format), `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (from `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/core-closure.mjs --check` and `node scripts/native/parity-ledger.mjs --check` green with the 12
  rows `native` and their routes present in `apps/mobile/app/`.
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form) then mirrored; RTL (`ar`) covered; no
  hardcoded user-visible text; no physical `left`/`right`; no raw `toLocaleX` / `date-fns format`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (this lane's read-only spec) and `plan-sparring.md`.
- **Device-runtime parity (task 8)** is deferred to G1 as `next_actor: owner`; not a merge blocker, recorded in this
  log and `staging-tests.json`.
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 12 rows), `packages/core/manifest.json`
+ `closure.generated.json` + `src/**` and `scripts/native/mobile-ci-paths.generated.json` (only this lane's
re-exports), `apps/mobile/src/ports/**` and `apps/mobile/src/navigation/resolve.ts` (native infra), and the DE-first
i18n shard are shared by row/line with the other two lanes; resolve a merge conflict by keeping both lanes' rows/keys.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only; the native app has no production profile.
## Log
### 2026-10-21T20:30Z · kiro-planner · created → ready
Lane drafted with the plan (`state: drafted` in `handoff.md`). The 12 rows and the paths were computed from the parity
ledger and `src/App.tsx` so no file belongs to two lanes; `depends_on: []` — disjoint native subtree and disjoint core
entry files from the other two lanes. Next: PLAN-SPAR spars the plan; once a VTID is written here, seat `exafyltd`
claims the lane (`queue.mjs claim native-wave2-events-calendar/events-meetups --session <id>`).
