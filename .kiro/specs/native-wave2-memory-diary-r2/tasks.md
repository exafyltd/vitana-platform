# Tasks — Native Wave 2: Memory / Diary screen ports

Two lanes, disjoint `paths`. Design: `design.md` and `requirements.md` in this folder are authoritative — follow
them exactly; anything outside them is a plan change (log it, set `next_actor: claude` only if Claude is available,
else park per collaboration §7a). VTIDs are assigned by CI after PLAN-SPAR converges; do not start a lane before its
`vtid:` is set in `lanes/<id>.md`. All commands run from `apps/mobile/` unless noted; `assertNotProduction()` and the
no-production-profile rule make every command offline. The whole cluster is **class-B native re-implementation**
against the native gateway helper in `apps/mobile/src/auth/gateway.ts` (`getGateway()`/`gatewayGet()`, wrapping
`@vitana/core/gateway`'s `createGatewayFetch`/`gatewayJson`) and the native Supabase client reached through the
`core` port (`@vitana/core/supabase` → `apps/mobile/src/auth/client.ts`) — never a direct `@supabase/supabase-js`
import in screen code (design §2 ports-only rule) — so no `@vitana/core` re-export is expected (ledger-findings §3);
the re-export task below fires only if a genuinely pure class-A helper is found.

<!-- lane: memory -->
## Lane `memory` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports: `MEMORY.OVERVIEW /memory`, `MEMORY.TIMELINE /memory/timeline`, `MEMORY.RECALL /memory/recall`,
`MEMORY.PERMISSIONS /memory/permissions` (4 ledger rows under `"lane": "memory-diary"`). depends_on: none. Web
sources `src/pages/Memory.tsx` (124), `memory/Timeline.tsx` (66), `memory/Recall.tsx` (350), `memory/Permissions.tsx`
(62). Every data path is class-B.

- [ ] 1. Core re-export (conditional — class-A only): IF, while implementing, a genuinely pure class-A helper is
  found (ledger-findings §3 found none — the pure presentation helpers `timeline-meta.tsx`/`routine-text.ts` are
  **mirrored** into native helpers + i18n keys, not re-exported), add its `packages/core/manifest.json` line + a
  re-export in `packages/core/src/**`, then `node scripts/native/core-closure.mjs --write` and commit the regenerated
  `packages/core/closure.generated.json` and `scripts/native/mobile-ci-paths.generated.json` in the SAME PR. Default:
  no core change — the class-B data paths are re-implemented natively against the native gateway helper
  (`getGateway()`/`gatewayGet()` in `apps/mobile/src/auth/gateway.ts`, wrapping `@vitana/core/gateway`'s
  `createGatewayFetch`/`gatewayJson`) and the native Supabase client via the `core` port (`@vitana/core/supabase`
  → `apps/mobile/src/auth/client.ts`) — never a direct `@supabase/supabase-js` import in screen code.
  Files: `packages/core/manifest.json`, `packages/core/src/**`, `packages/core/closure.generated.json`,
  `scripts/native/mobile-ci-paths.generated.json` (only if a class-A promotion happens).
  Verify (repo root): `node scripts/native/core-closure.mjs --check` passes; `apps/mobile` → `npm run typecheck` green.
- [ ] 2. Memory overview + timeline screens: `apps/mobile/app/(app)/memory/index.tsx` +
  `apps/mobile/src/screens/memory/MemoryOverview.tsx` (twin of `Memory.tsx` — garden categories, what-Vitana-knows,
  index-week, routines, education; data via the core gateway helper), and `apps/mobile/app/(app)/memory/timeline.tsx`
  + `apps/mobile/src/screens/memory/MemoryTimeline.tsx` (twin of `Timeline.tsx` → `TimelineBody`, list + detail sheet
  off `/api/v1/timeline`). Mobile-web branch only; add-memory / category-detail open as bottom sheets.
  Files: `apps/mobile/app/(app)/memory/index.tsx`, `apps/mobile/app/(app)/memory/timeline.tsx`,
  `apps/mobile/src/screens/memory/**`.
  Verify: `npm test` (the memory unit tests below) + `npm run typecheck` green.
- [ ] 3. Recall + permissions screens: `apps/mobile/app/(app)/memory/recall.tsx` +
  `apps/mobile/src/screens/memory/MemoryRecall.tsx` (twin of `Recall.tsx` — static mock body + honest empty state
  `SpotlightEmpty`, `RecallMasterActionPopup`, no live read), and `apps/mobile/app/(app)/memory/permissions.tsx` +
  `apps/mobile/src/screens/memory/MemoryPermissions.tsx` (twin of `Permissions.tsx` → `LearningSwitches`,
  `UsageDataCard`; learning prefs + usage export/delete via the core gateway helper).
  Files: `apps/mobile/app/(app)/memory/recall.tsx`, `apps/mobile/app/(app)/memory/permissions.tsx`,
  `apps/mobile/src/screens/memory/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 4. i18n + RTL: user-visible strings from the web shards (`screens.memory.*`, `timeline.*`, `memoryLearning.*`,
  `spotlightMember.memory.*`); any genuinely new key added to `src/i18n/de/memoryNative.json` first, then the other
  ten (ar de en es fr pl pt ru sr tr zh; **pt = Brazilian Portuguese você-form**); render under `ar` with start/end
  only; no hardcoded text, no physical `left`/`right`. The mirrored `timeline-meta`/`routine-text` strings become
  keys here.
  Files: `src/i18n/*/memoryNative.json` (DE first), `apps/mobile/src/screens/memory/**`.
  Verify: `npm run typecheck`; `npm test` — the no-raw-text and no-physical-direction tests pass.
- [ ] 5. Unit tests (fake gateway / fixtures, no network): overview sections render loaded/empty/error; timeline list
  + detail open/empty/error; recall static body + empty state; permissions switches read + write + usage export.
  React 19 — `ReactElement`, no global `JSX`.
  Files: `apps/mobile/tests/memory/**`.
  Verify: `npm test` green; `APP_PROFILE=development npm run bundle` and
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 6. Flip the lane's parity rows to `native` and verify: `node scripts/native/parity-ledger.mjs --sync` (status
  edited by hand to `native` for the 4 memory rows), then `--check`.
  Files: `apps/mobile/parity/ledger.json` (memory rows only), `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 7. **(depends-on-owner / G1 — `next_actor: owner`)** Device-runtime parity: Maestro journey(s)
  `apps/mobile/maestro/memory/*.yaml`, iOS simulator + Android emulator screenshots at the device sizes, screenshot
  parity vs the 390×844 read-only staging web `/memory*`. Blocked until G1 (and macOS minutes / G3 for iOS on a
  device).
  Files: `apps/mobile/maestro/memory/**`, `docs/validation/<VTID>/staging-tests.json`.
  Verify: on G1 only; recorded in the lane log, not run in CI.
- [ ] 8. PR: branch `kiro/native-wave2-memory-diary-r2/memory`, title
  `VTID-xxxxx (native-wave2-memory-diary-r2/memory): native memory overview / timeline / recall / permissions port`,
  body names the Kiro session id, Summary / Decisions taken / Tests / Handoff. Commit trailers
  `Collab-Session: <kiro id>`, `Collab-Lane: native-wave2-memory-diary-r2/memory`. Lane → `in-review`,
  `next_actor: kiro` (reviewer agent `vitana-lane-reviewer`). Never merge, deploy or write to a live system
  (protocol §7a).

<!-- lane: diary -->
## Lane `diary` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports: `MEMORY.DAILY_DIARY /daily-diary`, `MEMORY.DIARY /daily-diary?tab=health`,
`MEMORY.DIARY_BUGS /daily-diary?tab=bugs` (3 ledger rows — one web page via the `tab` param, one native route, all 3
flip together). depends_on: none. Web source `src/pages/MobileDailyDiary.tsx` (193). Every data path is class-B;
photo/audio capture use new native deps.

- [ ] 1. Core re-export (conditional — class-A only): same rule as memory task 1 — only if a genuinely pure class-A
  helper is found (ledger-findings §3 found none; `gardenCategoryKey`/`formatIndexDelta` live inside class-B modules
  and are re-derived natively). Default: no core change — diary data paths re-implemented natively against the native
  gateway helper (`getGateway()`/`gatewayGet()` in `apps/mobile/src/auth/gateway.ts`, wrapping
  `@vitana/core/gateway`'s `createGatewayFetch`/`gatewayJson`) and the native Supabase client via the `core` port
  (`@vitana/core/supabase` → `apps/mobile/src/auth/client.ts`) — never a direct `@supabase/supabase-js` import in
  screen code.
  Files: `packages/core/manifest.json`, `packages/core/src/**`, `packages/core/closure.generated.json`,
  `scripts/native/mobile-ci-paths.generated.json` (only if a class-A promotion happens).
  Verify (repo root): `node scripts/native/core-closure.mjs --check`; `apps/mobile` → `npm run typecheck` green.
- [ ] 2. Native deps + permissions: add `expo-image-picker` and a native audio recorder (`expo-audio`/`expo-av`,
  pick the one consistent with `apps/mobile/`) to `apps/mobile/package.json`; add the camera / photo-library /
  microphone permission strings to the app's Expo config `apps/mobile/app.config.ts` (the app uses `app.config.ts`,
  there is no `app.json`). Both paths are in this lane's `paths` allow-list (and only this lane's) so the PR-GATE
  Lane scope check passes. These replace web's browser Supabase-Storage upload + MediaRecorder / Web Speech
  (class-B, device-only).
  Files: `apps/mobile/package.json`, `apps/mobile/app.config.ts`.
  Verify: `npm run typecheck`; `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 3. Daily Diary screen (one route, `tab` param): `apps/mobile/app/(app)/daily-diary/index.tsx` +
  `apps/mobile/src/screens/diary/DailyDiaryScreen.tsx`, reading `tab` (`health` default | `bugs`) to pick the
  `MobileModePill` mode. Health mode: `UnifiedCaptureCard` + `TextDiaryEditor` (save via `memory-api.saveDiaryEntry`
  through the core gateway helper) + `PhotoDiaryUploader` (expo-image-picker → Supabase Storage + index sync) +
  `DiaryEntryList` (read/delete, native supabase realtime); audio capture via the native recorder + native/back-end
  STT → saved entry. Bugs mode: `FeedbackReportList` (ticket list) + ticket submit (twin of `FeedbackRecorder`).
  Mobile-web branch only.
  Files: `apps/mobile/app/(app)/daily-diary/index.tsx`, `apps/mobile/src/screens/diary/**`.
  Verify: `npm test` (the diary unit tests below) + `npm run typecheck` green.
- [ ] 4. i18n + RTL: user-visible strings from the web shards (`diary.*`, feedback/support keys); any genuinely new
  key added to `src/i18n/de/diaryNative.json` first, then the other ten (ar de en es fr pl pt ru sr tr zh; **pt =
  Brazilian Portuguese você-form**); render under `ar` with start/end only; no hardcoded text, no physical
  `left`/`right`.
  Files: `src/i18n/*/diaryNative.json` (DE first), `apps/mobile/src/screens/diary/**`.
  Verify: `npm run typecheck`; `npm test` — the no-raw-text and no-physical-direction tests pass.
- [ ] 5. Unit tests (fake gateway / fixtures, no network — picker + recorder faked): health-mode entry list
  loaded/empty/error; text entry save; photo picker invoked + upload path; entry delete; bugs-mode ticket list
  loaded/empty/error; `tab` switch health↔bugs. React 19 — `ReactElement`, no global `JSX`.
  Files: `apps/mobile/tests/diary/**`.
  Verify: `npm test` green; `APP_PROFILE=development npm run bundle` and
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 6. Flip the lane's parity rows to `native` and verify: `node scripts/native/parity-ledger.mjs --sync` (status
  edited by hand to `native` for all 3 diary rows — they flip together), then `--check`.
  Files: `apps/mobile/parity/ledger.json` (diary rows only), `docs/validation/<VTID>/{scope,staging-tests}.json`.
  `scope.json` must list **every** touched path, including the task-2 dependency/permission files
  (`apps/mobile/package.json`, `apps/mobile/app.config.ts`), so it does not under-report the lane footprint.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 7. **(depends-on-owner / G1 — `next_actor: owner`)** Device-runtime parity: Maestro journey(s)
  `apps/mobile/maestro/diary/*.yaml`, iOS simulator + Android emulator screenshots at the device sizes, screenshot
  parity vs the 390×844 read-only staging web `/daily-diary`, **and the live camera/microphone capture exercise**
  (device-only). Blocked until G1 (and macOS minutes / G3 for iOS on a device). No diary write is exercised against a
  live system (root `CLAUDE.md` absolute rule) — the capture exercise runs only in the isolated G1 environment.
  Files: `apps/mobile/maestro/diary/**`, `docs/validation/<VTID>/staging-tests.json`.
  Verify: on G1 only; recorded in the lane log, not run in CI.
- [ ] 8. PR: branch `kiro/native-wave2-memory-diary-r2/diary`, title
  `VTID-xxxxx (native-wave2-memory-diary-r2/diary): native daily-diary port`; body names the Kiro session id, Summary /
  Decisions taken / Tests / Handoff. Commit trailers `Collab-Session: <kiro id>`,
  `Collab-Lane: native-wave2-memory-diary-r2/diary`; lane → `in-review`, `next_actor: kiro` (reviewer agent
  `vitana-lane-reviewer`). No merge/deploy/live write.

## Acceptance (every lane; the reviewer agent checks these)
- Requirements R1–R6 met for the lane's screens; mobile-web parity, N2/N3 composition, class-B data paths
  re-implemented natively against the native gateway helper (`getGateway()`/`gatewayGet()` in
  `apps/mobile/src/auth/gateway.ts`, wrapping `@vitana/core/gateway`) and the native Supabase client via the `core`
  port (`@vitana/core/supabase` → `apps/mobile/src/auth/client.ts`) — never a direct `@supabase/supabase-js` import
  in screen code, never a web component import; `@vitana/core` the only web bridge; any class-A promotion done in-PR
  with the generated files committed.
- `npm run typecheck`, `npm test`, `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green; `node scripts/native/parity-ledger.mjs --check`
  green with the lane's rows `native`; `node scripts/native/core-closure.mjs --check` green.
- 11 locales, DE-first new keys (du-form; pt você-form), RTL (`ar`) covered; no hardcoded user-visible text; no
  physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** and **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (read-only) and `plan-sparring.md`.
- Device-runtime parity (task 7) is deferred to G1 as `next_actor: owner`; it is not a merge blocker for the port,
  it is recorded in the lane log and `staging-tests.json`.
- Never: VTID allocation, merge/approve, workflow dispatch, deploy, Supabase/AWS writes, or any test against
  production (protocol §7a; program §6). The native app has no production profile; staging specs read-only.
