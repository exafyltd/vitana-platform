---
lane: live-rooms
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(app)/comm/live-rooms/**
  - apps/mobile/src/screens/liverooms/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/maestro/liverooms/**
  - apps/mobile/tests/liverooms/**
  - packages/core/manifest.json
  - packages/core/closure.generated.json
  - packages/core/src/**
  - scripts/native/mobile-ci-paths.generated.json
  - apps/mobile/parity/ledger.json
  - src/i18n/*/liveRoomsNative.json
  - docs/validation/**
updated: 2026-10-21T20:30Z
---
# Live-rooms port — `/comm/live-rooms` (+ tabs) and `/comm/live-rooms/:roomId/view` (Daily.co)
Plan: `.kiro/specs/native-wave2-events-calendar/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: live-rooms -->` (tasks 1–8) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not
start before `vtid:` is set here. depends_on: none — runs in parallel with `events-meetups` and `calendar-reminders`.
**Measured on the worktree (= origin/main):** 6 ledger rows under `"lane": "events-calendar"` for this lane, all
`not_started` — `COMM.LIVE_ROOMS /comm/live-rooms`, `COMM.LIVE_ROOMS_ALL ?tab=all`, `COMM.LIVE_ROOMS_LIVE ?tab=live`,
`COMM.LIVE_ROOMS_PAST ?tab=past`, `COMM.LIVE_ROOMS_SCHEDULED ?tab=scheduled`, and
`COMM.LIVE_ROOM_VIEWER /comm/live-rooms/:roomId/view`. Web sources `src/pages/community/LiveRooms.tsx` (1073 lines,
**class-B**; route `src/App.tsx:1253-1255`), `src/pages/community/LiveRoomViewer.tsx` (421 lines, **class-B**; route
`src/App.tsx:1258-1260`), `src/components/liverooms/DailyVideoRoom.tsx` (88, Daily.co),
`src/components/liverooms/LiveRoomDrawer.tsx` (670), `src/components/events/EventsLiveRooms.tsx` (281).
**Goal.** Port the live-rooms list and viewer to native on the N3 shell at 1:1 mobile-web parity: the
all/live/past/scheduled tabs via the `tab` search param, a live-room card list, the live-room drawer (twin of
`LiveRoomDrawer.tsx`) with interested-people, and the viewer with host detection, room state and the Daily.co join
surface (twin of `DailyVideoRoom.tsx`). `LiveRooms.tsx`/`LiveRoomViewer.tsx` are class-B (runtime Supabase) and are
re-implemented natively; only the pure helpers `liveRoomFormat.ts` + the `vcard` `liveRoom.ts` adapter move into
`@vitana/core` (task 1). Scheduled / "starting soon" labels via `@/lib/locale-format`. **The actual Daily.co video
join / publisher / subscriber flow is NOT exercisable offline — it is fully G1-deferred (task 7); the offline unit
tests cover token fetch, room-state mapping, host detection, tab filter and the pre-join UI only.** Flips the 6 parity
rows to `native`.
**Acceptance (the reviewer seat checks these):**
- Requirements R1–R6 for the live-rooms surfaces; mobile-web parity; `@vitana/core`-only web bridge; no class-B
  module moved into core.
- `npm run typecheck`, `npm test` (list loaded/empty/error per tab; tab filter; drawer open/dismiss +
  interested-people; viewer room-state mapping; token-fetch error; host detection; dates via locale-format — **no real
  Daily.co join in any test**), `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (from `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/core-closure.mjs --check` and `node scripts/native/parity-ledger.mjs --check` green with the 6
  rows `native` and their routes present in `apps/mobile/app/`.
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form) then mirrored; RTL (`ar`) covered; no
  hardcoded user-visible text; no physical `left`/`right`; no raw `toLocaleX` / `date-fns format`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (this lane's read-only spec) and `plan-sparring.md`.
- **Device-runtime parity AND the Daily.co video join (task 7)** are deferred to G1 as `next_actor: owner`; not a merge
  blocker for the port, recorded in this log and `staging-tests.json`. The join has no offline substitute.
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 6 rows), `packages/core/manifest.json`
+ `closure.generated.json` + `src/**` and `scripts/native/mobile-ci-paths.generated.json` (only this lane's
re-exports — the live-room helpers), `apps/mobile/src/ports/**` and `apps/mobile/src/navigation/resolve.ts` (native
infra), and the DE-first i18n shard are shared by row/line with the other two lanes; resolve a merge conflict by
keeping both lanes' rows/keys.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only; the native app has no production profile.
## Log
### 2026-10-21T20:30Z · kiro-planner · created → ready
Lane drafted with the plan (`state: drafted` in `handoff.md`). The 6 rows and the paths were computed from the parity
ledger and `src/App.tsx` so no file belongs to two lanes; `depends_on: []` — disjoint native subtree and disjoint core
entry files from the other two lanes. The Daily.co video join is explicitly flagged as having no offline test and
being fully G1-deferred. Next: PLAN-SPAR spars the plan; once a VTID is written here, seat `exafyltd` claims the lane
(`queue.mjs claim native-wave2-events-calendar/live-rooms --session <id>`).
