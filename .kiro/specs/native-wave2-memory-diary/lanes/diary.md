---
lane: diary
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(app)/daily-diary/**
  - apps/mobile/src/screens/diary/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/tests/diary/**
  - apps/mobile/maestro/diary/**
  - apps/mobile/package.json
  - apps/mobile/app.config.ts
  - packages/core/manifest.json
  - packages/core/closure.generated.json
  - packages/core/src/**
  - scripts/native/mobile-ci-paths.generated.json
  - apps/mobile/parity/ledger.json
  - src/i18n/*/diaryNative.json
  - docs/validation/**
updated: 2026-10-21T19:13Z
---
# Daily Diary port — the 3 `memory-diary` ledger rows under `/daily-diary*`
Plan: `.kiro/specs/native-wave2-memory-diary/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: diary -->` (tasks 1–8) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start
before `vtid:` is set here.
**Measured on the worktree (= vitana-v1 origin/main, ledger version 2, 435 rows):** 3 ledger rows under
`"lane": "memory-diary"` for this lane, all `not_started` — `MEMORY.DAILY_DIARY /daily-diary`,
`MEMORY.DIARY /daily-diary?tab=health`, `MEMORY.DIARY_BUGS /daily-diary?tab=bugs` (every row `kind: screen`,
`scope: in`, `source: registry`, `exception: null`, `owner: null`). All three resolve to the SAME web page
component (`src/pages/MobileDailyDiary.tsx`, 193 lines, route `src/App.tsx:1120`); `?tab=health`/`?tab=bugs` only
pick the `MobileModePill` mode (`searchParams.get("tab")`, default `health`). The native port is **one route** that
reads the `tab` query param — the three rows flip to `native` together.
**Goal.** Port the Daily Diary screen to native on the N3 shell at 1:1 mobile-web parity: unified capture
(`UnifiedCaptureCard`), text editor (`TextDiaryEditor`), photo upload (`PhotoDiaryUploader`), entry list
(`DiaryEntryList`) and the bug/feedback report list (`FeedbackReportList` → `MyTicketsList`), with the health/bugs
mode from the `tab` query param. Every diary data module is **class-B** (ledger-findings §3): diary rows read/
write/delete through `memory-api`/supabase realtime, so they are re-implemented natively against the native gateway
helper in `apps/mobile/src/auth/gateway.ts` (`getGateway()`/`gatewayGet()`, wrapping `@vitana/core/gateway`'s
`createGatewayFetch`/`gatewayJson`) and the native Supabase client reached through the `core` port
(`@vitana/core/supabase` → `apps/mobile/src/auth/client.ts`) — never a direct `@supabase/supabase-js` import in
screen code — NOT core-extracted. **Photo upload** → native `expo-image-picker` + Supabase
Storage (web uses Supabase Storage); **audio capture** → a native expo audio recorder (`expo-audio`/`expo-av`) +
native/back-end STT (web uses MediaRecorder + Web Speech / backend STT). `expo-image-picker` and the expo audio
recorder are **new native deps** not yet in `apps/mobile/package.json` — added in this lane's PR, which is why this
lane's `paths` (and only this lane's — `memory` touches neither) include `apps/mobile/package.json` and
`apps/mobile/app.config.ts` (the app's real Expo config; there is no `app.json` in `apps/mobile/`). Flips all 3 rows
to `native`.
**Acceptance (the reviewer agent checks these):**
- Requirements R1–R6 for all 3 rows (one screen, tab param); mobile-web parity; `@vitana/core`-only web bridge for
  any class-A helper; class-B capture/entry modules re-implemented natively (photo → expo-image-picker + Supabase
  Storage; audio → expo audio recorder + native/back-end STT), never a web component import (ledger-findings §3).
- `npm run typecheck`, `npm test` (health mode load/empty/error; bugs mode ticket list load/empty/error; text entry
  save; photo picker invoked + upload path; entry delete; tab switch health↔bugs), `APP_PROFILE=development npm run
  bundle`, `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (from `apps/mobile/`); React 19
  `ReactElement`.
- `node scripts/native/core-closure.mjs --check` and `node scripts/native/parity-ledger.mjs --check` green with all 3
  rows `native` and the `/daily-diary` route present in `apps/mobile/app/`.
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form; pt is Brazilian Portuguese você-form)
  then mirrored; RTL (`ar`) covered with start/end only; no hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (this lane's read-only spec) and `plan-sparring.md`.
- **Device-runtime parity (task 8)** is deferred to G1 as `next_actor: owner`; not a merge blocker, recorded in this
  log and `staging-tests.json`. (Photo/audio capture is a device-only path — its live exercise is part of the G1
  task; the offline unit tests fake the picker/recorder.)
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 3 rows), `packages/core/manifest.json`
+ closure + `src/**` + `scripts/native/mobile-ci-paths.generated.json` (only this lane's re-exports, if any class-A
helper is promoted; ledger-findings §3 found none, so likely none), `apps/mobile/src/ports/**`,
`apps/mobile/src/navigation/resolve.ts`, and the DE-first i18n shard are shared by row/line; resolve a merge conflict
by keeping both lanes' rows/keys.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only; the native app has no production profile.
## Log
### 2026-10-21T19:13Z · kiro-planner · created → ready
Lane drafted with the plan (`state: drafted` in `handoff.md`). The 3 rows and the paths were computed from the
vitana-v1 origin/main parity ledger and `src/App.tsx` so no file belongs to two lanes. The 3 rows are one web page
with a `tab` param → one native route (`app/(app)/daily-diary/index.tsx` under the `daily-diary/**` subtree), all
three flip together. No deps — runs in parallel with `memory`. Next: PLAN-SPAR spars the
`plan(native-wave2-memory-diary)` PR; once a VTID is written here, seat `exafyltd` claims the lane
(`queue.mjs claim native-wave2-memory-diary/diary --session <id>`). No VTID allocated, no product code changed, no
live system touched.
