---
lane: calendar-reminders
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(app)/calendar/**
  - apps/mobile/app/(app)/reminders/**
  - apps/mobile/src/screens/calendar/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/maestro/calendar/**
  - apps/mobile/tests/calendar/**
  - packages/core/manifest.json
  - packages/core/closure.generated.json
  - packages/core/src/**
  - scripts/native/mobile-ci-paths.generated.json
  - apps/mobile/parity/ledger.json
  - src/i18n/*/calendarNative.json
  - docs/validation/**
updated: 2026-10-21T20:30Z
---
# Calendar / reminders port — `/calendar` (+ entry deep-link), `/reminders` (+ fire deep-link)
Plan: `.kiro/specs/native-wave2-events-calendar/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: calendar-reminders -->` (tasks 1–9) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do
not start before `vtid:` is set here. depends_on: none — runs in parallel with `events-meetups` and `live-rooms`.
**Measured on the worktree (= origin/main):** 4 ledger rows under `"lane": "events-calendar"` for this lane, all
`not_started` — `CALENDAR.OVERVIEW /calendar` (overlay), `REMINDERS.OVERVIEW /reminders` (screen), and the exclusion
deep-link routes `/calendar/entry/:entryId` and `/reminders/fire/:fireId`. Web sources `src/pages/Calendar.tsx`
(552 lines, **class-B**; routes `src/App.tsx:1185-1201`), the calendar subtree `src/components/calendar/vcal/**`
(EntryScreen, AddEntrySheet, views, sections, FindTime, OverlapWarning, labels, time, theme, guidance) +
`src/components/calendar/MobileEventForm.tsx`, `src/pages/Reminders.tsx` (66 lines; routes `src/App.tsx:1203-1219`),
`src/components/reminders/RemindersPanel.tsx` (425), `src/components/reminders/ReminderInterruptOverlay.tsx` (252).
**Goal.** Port the calendar overlay/screen and the reminders screen to native on the N3 shell at 1:1 mobile-web
parity: month/week/day views, entry list, the add-entry sheet (twin of `vcal/AddEntrySheet.tsx` +
`MobileEventForm.tsx`), FindTime / overlap-warning behaviour; the reminders list and the `/reminders/fire/:fireId`
interrupt-overlay target. `Calendar.tsx` is class-B (runtime Supabase) and is re-implemented natively; only the pure
calendar helpers (`calendar-entry.ts`, `vcal/{time,labels,guidance,theme}.ts`) move into `@vitana/core` (task 1).
**The date/time locale-helper rule is load-bearing on this lane** — every date and time is rendered via `fmtDate` /
`fmtTime` / `fmtDateTime` / `formatDate` from `@/lib/locale-format`, never raw `toLocaleX`, never `date-fns format`
(ESLint `i18n/no-raw-locale-call`, ERROR). Flips the 4 parity rows to `native`.
**Acceptance (the reviewer seat checks these):**
- Requirements R1–R6 for the calendar + reminders surfaces; mobile-web parity; `@vitana/core`-only web bridge; no
  class-B module moved into core.
- `npm run typecheck`, `npm test` (calendar loaded/empty/error; view switch; add-entry sheet; entry deep-link + back;
  reminders list; fire deep-link + interrupt overlay; dates via locale-format), `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (from `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/core-closure.mjs --check` and `node scripts/native/parity-ledger.mjs --check` green with the 4
  rows `native` and their routes present in `apps/mobile/app/`.
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form) then mirrored; RTL (`ar`) covered; no
  hardcoded user-visible text; no physical `left`/`right`; **no raw `toLocaleX` / `date-fns format` — locale-format
  helpers only**.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (this lane's read-only spec) and `plan-sparring.md`.
- **Device-runtime parity (task 8)** is deferred to G1 as `next_actor: owner`; not a merge blocker, recorded in this
  log and `staging-tests.json`.
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 4 rows), `packages/core/manifest.json`
+ `closure.generated.json` + `src/**` and `scripts/native/mobile-ci-paths.generated.json` (only this lane's
re-exports — the calendar helpers), `apps/mobile/src/ports/**` and `apps/mobile/src/navigation/resolve.ts` (native
infra), and the DE-first i18n shard are shared by row/line with the other two lanes; resolve a merge conflict by
keeping both lanes' rows/keys.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only; the native app has no production profile.
## Log
### 2026-10-21T20:30Z · kiro-planner · created → ready
Lane drafted with the plan (`state: drafted` in `handoff.md`). The 4 rows and the paths were computed from the parity
ledger and `src/App.tsx` so no file belongs to two lanes; `depends_on: []` — disjoint native subtree and disjoint core
entry files from the other two lanes. The locale-format rule is called out as load-bearing because this is the densest
date/time surface in the cluster. Next: PLAN-SPAR spars the plan; once a VTID is written here, seat `exafyltd` claims
the lane (`queue.mjs claim native-wave2-events-calendar/calendar-reminders --session <id>`).
