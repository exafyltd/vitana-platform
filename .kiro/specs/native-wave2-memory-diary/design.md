# Design — Native Wave 2: Memory / Diary screen ports (native-wave2-memory-diary)

How the two lanes port the `memory-diary` ledger cluster to native. Follows
`docs/programs/native-app/NATIVE-APP-PLAN.md` §3 (architecture) and §4 (parity method), the N3 shell and N2 UI kit
already on main, and `apps/mobile/README.md`. The class determination and the lane partition are from
`sparring/ledger-findings.md` (read-only, verified against vitana-v1 origin/main). Nothing here changes the program
plan or the design contract.

## 1. Where native screens live and how they resolve

Wave 1 N3 (VTID-05186) built the shell and a resolver route: `apps/mobile/app/(app)/[...path].tsx` renders every
ledger destination that is not yet native as "Unported", admin as the web console, unknown as not-found
(`apps/mobile/parity/ledger.json` `native_only` entry for `/*`). Porting a screen means **adding its own Expo Router
file under `apps/mobile/app/`** whose route path equals the web path, so the resolver no longer catches it, the push
`data.url` / universal link / ORB directive resolve the same, and the parity row can go `native`
(`scripts/native/parity-ledger.mjs` `fileToRoute()` maps `app/(app)/foo/[id].tsx` → `/foo/:id`).

Route-file plan (Expo Router, paths = web paths):

| Lane | Native route file(s) under `apps/mobile/app/` | Web path(s) |
|---|---|---|
| `memory` | `(app)/memory/index.tsx`, `(app)/memory/timeline.tsx`, `(app)/memory/recall.tsx`, `(app)/memory/permissions.tsx` (optional `(app)/memory/_layout.tsx` for the stack) | `/memory`, `/memory/timeline`, `/memory/recall`, `/memory/permissions` |
| `diary` | `(app)/daily-diary/index.tsx` (reads the `tab` search param `health`\|`bugs`) | `/daily-diary`, `/daily-diary?tab=health`, `/daily-diary?tab=bugs` |

Query-string variants (`?tab=health`/`?tab=bugs`) are the **same route file** reading the search param, exactly as
the web screen reads `searchParams.get("tab")` — they are distinct ledger rows but not distinct files, so they do not
overlap across lanes. The ledger's shape-matching (`shapeOf`, query dropped) is satisfied by the single file, and the
three diary rows flip to `native` together. The native `/daily-diary` route lives under its own subtree
(`app/(app)/daily-diary/**`), disjoint from `app/(app)/memory/**`, so the two lanes' native file trees do not collide
even though both share the ledger prefix mapping.

## 2. Screen source: the N2/N3 structure, not the web DOM

Each lane re-implements the **mobile web** branch of its source screen with React Native primitives:

- Imports go through ports only: `@vitana/core/*` (hooks, query keys, types, registry, the gateway helper),
  `@vitana/ui` (UI kit), `@vitana/tokens` (visual values), `src/ports/*` from the shell (`core`, `ui`, `links`,
  `badges`, `soundscape`, `orb-slot`). No `@/…` web import (ESLint-banned in app code).
- The web→native prop map (`apps/mobile/README.md`) is mechanical: `onClick`→`onPress`, `className`→`style`,
  shadcn `Card`→`VCard`/`Panel`, `Dialog`/`Sheet`/`ResponsiveDialog`→the kit's modal / bottom sheet,
  `toast`/`notify*`→`@vitana/ui`/`@vitana/ui/sonner`, list/scroll→`FlatList`/`ScrollView`.
- Mobile patterns already in the shell are reused: `MobileModePill` (the diary health/bugs pill and the memory
  sub-nav), bottom sheets for the add-memory / category-detail / capture dialogs.

### 2a. Class determination: the whole cluster is class-B (why native re-implementation, not core-extraction)

A web module is **class-B** (re-implemented natively, NOT core-extracted) if it imports
`@/integrations/supabase/client` or `@/lib/community-gateway` directly or transitively. `@/lib/memory-api`,
`@/lib/memory-learning-api`, `@/lib/timeline-api` and `@/lib/diary-index-sync` all import `@/lib/community-gateway`
(`memory-api.ts:8`, `diary-index-sync.ts:1`), so every module importing them at runtime is class-B (ledger-findings
§3, premise verified by reading imports). **Every runtime data path in both clusters is class-B** — memory garden /
add-memory / what-Vitana-knows (`AddMemoryDialog`, `WhatVitanaKnows`, `MemoryCategoryGrid`, `useKnowledgeBase`),
learning (`LearningSwitches`, `UsageDataCard`, `RoutinesCard`), the whole timeline (`TimelineBody`,
`IndexSpotlightCard`, `TimelineRows`, `TimelineDetailSheet`), and every diary capture / entry / feedback module
(`DiaryEntryList`, `TextDiaryEditor`, `PhotoDiaryUploader`, `UnifiedCaptureCard`, `FeedbackReportList` →
`MyTicketsList`, `FeedbackRecorder`). These are re-implemented natively against the native gateway helper in
`apps/mobile/src/auth/gateway.ts` — `getGateway()` / `gatewayGet()`, which wrap `@vitana/core/gateway`'s
`createGatewayFetch` / `gatewayJson` imported via `src/ports/core` (gateway.ts does **not** itself export the two
`@vitana/core` symbols) — and the native Supabase client reached through the `core` port (`@vitana/core/supabase`
re-exported by `src/ports/core.ts`, backed by `apps/mobile/src/auth/client.ts`; `@supabase/supabase-js` is already a
native dep but screen code never imports it directly, per the ports-only rule in §2) — **not** given a `@vitana/core`
re-export, because a core re-export would pull the class-B module into the `core-closure.mjs` BFS where its
`community-gateway`/supabase import fails `--check` (`m.own !== 'A'`).

**No clean full-module class-A re-export exists** in either cluster. The only genuinely pure logic is embedded
presentation helpers that native **mirrors**, not re-exports, because they still pull web-only deps or live inside a
class-B module: `components/timeline/timeline-meta.tsx` (pillar/catalog icon+text maps, `lucide-react`),
`components/memory/learning/routine-text.ts` (routine phrasing), and the pure functions
`lib/memory-api.gardenCategoryKey` / `lib/diary-index-sync.formatIndexDelta` (both inside class-B modules). Their
text becomes DE-first i18n keys and small native helpers. **If** implementation finds a genuinely pure class-A
module to promote, the owning lane adds exactly ONE `@vitana/core` re-export in the SAME PR (manifest line +
`packages/core/src/**` re-export + `core-closure.mjs --write` + committed `closure.generated.json` +
`mobile-ci-paths.generated.json`); default: none.

### 2b. Memory lane specifics

Memory overview (`Memory.tsx`) composes `AddMemoryDialog`, `MemoryCategoryGrid`, `WhatVitanaKnows`,
`MemoryTimelineTab`, `MemoryEducationTab`, `IndexWeekStory`, `RoutinesCard` — native twins fetch garden categories /
entries and the self-awareness summary through the core gateway helper. Timeline (`Timeline.tsx` → `TimelineBody`)
renders the `/api/v1/timeline` index as a native list/detail. Recall (`Recall.tsx`) has a **static mock body + honest
empty state** (`SpotlightEmpty`, no live read) — it ports as a pure presentational screen (`RecallMasterActionPopup`,
`NewsCard`, `MotivationalBanner` twins). Permissions (`Permissions.tsx` → `LearningSwitches`, `UsageDataCard`) reads
and writes the learning prefs / usage export through `memory-learning-api` re-implemented natively.

### 2c. Diary lane specifics (capture is the hard part)

`MobileDailyDiary.tsx` is one screen with a `tab` param (`health` default, `bugs`): health mode shows
`UnifiedCaptureCard` + `TextDiaryEditor` + `PhotoDiaryUploader` + `DiaryEntryList`; bugs mode shows
`FeedbackReportList` (→ `MyTicketsList`). All class-B. The native re-implementation:

- **Text entry** → native editor saving through the `memory-api.saveDiaryEntry` path (`/api/v1/...memory/diary`) via
  the native gateway helper (`getGateway()`/`gatewayGet()` in `apps/mobile/src/auth/gateway.ts`); entry list reads +
  deletes (`deleteDiaryEntry`) with a native supabase realtime subscription on the client reached through the `core`
  port (`@vitana/core/supabase` → `apps/mobile/src/auth/client.ts`), never a direct `@supabase/supabase-js` import.
- **Photo** → `expo-image-picker` for selection, upload to **Supabase Storage** (same bucket as web) + the gateway
  index sync (`diary-index-sync`). Replaces web's Supabase-Storage-from-browser + `<input type=file>`.
- **Audio** → a native expo audio recorder (`expo-audio`/`expo-av`) + native/back-end STT, replacing web's
  MediaRecorder + Web Speech. The recorded transcript saves as a diary entry.
- **Bugs mode** → the feedback ticket list through the gateway tickets endpoints; ticket submit (`FeedbackRecorder`)
  re-implemented natively.

`expo-image-picker` and the expo audio recorder are **new native deps** added to `apps/mobile/package.json` in this
lane's PR; the camera / photo-library / microphone permission strings are added to the app's Expo config
`apps/mobile/app.config.ts` (the app uses `app.config.ts`, there is no `app.json`). Both `apps/mobile/package.json`
and `apps/mobile/app.config.ts` are in the `diary` lane's `paths` allow-list (and only the `diary` lane's — `memory`
touches neither) so the PR-GATE Lane scope check passes, and both are listed in the lane's `scope.json`. Capture is a
device-only path: the offline unit tests fake the picker/recorder; the live exercise is the G1 task.

## 3. Disjointness (no overlap, no orphan)

- **Ledger rows:** the 7 `memory-diary` rows partition cleanly — `memory` 4 (`MEMORY.OVERVIEW`, `MEMORY.TIMELINE`,
  `MEMORY.RECALL`, `MEMORY.PERMISSIONS`), `diary` 3 (`MEMORY.DAILY_DIARY`, `MEMORY.DIARY`, `MEMORY.DIARY_BUGS`).
  4 + 3 = 7. Each row named explicitly in the lane file.
- **Native files:** each lane owns a disjoint subtree of `apps/mobile/app/` (`app/(app)/memory/**` vs
  `app/(app)/daily-diary/**`) and `apps/mobile/src/screens/` (`src/screens/memory/**` vs `src/screens/diary/**`), its
  own `apps/mobile/tests/<cluster>/**` and `apps/mobile/maestro/<cluster>/**`. No file is in two lanes.
- **Tests:** each lane owns its `apps/mobile/tests/<cluster>/**` and its `docs/validation/<VTID>/` folder.
- **Shared, by-row-not-by-file:** `apps/mobile/parity/ledger.json` (each lane edits only its own rows),
  `packages/core/manifest.json` + `packages/core/src/**` closure + `scripts/native/mobile-ci-paths.generated.json`
  (each lane adds only the re-exports it needs — expected none, §2a), the shared native infra
  (`apps/mobile/src/ports/**`, `apps/mobile/src/navigation/resolve.ts`), and the DE-first i18n shards (each lane adds
  only its screens' keys). These are listed in each lane's `paths`.

## 4. Decisions (made by Kiro as planner; sparring may revise)

1. **Two lanes by cluster:** `memory` (`/memory*`) and `diary` (`/daily-diary*`). The prompt and the ledger assign
   the cluster to one parity-lane (`memory-diary`); the work splits it into two disjoint build lanes whose web
   prefixes, native route subtrees and native screen subtrees are all disjoint, so each builds, reviews and lands
   independently with the app buildable. Rationale recorded here per planning-mode rule.
2. **The whole cluster is class-B native re-implementation, not core-extraction** (§2a; ledger-findings §3). Every
   runtime data path imports `@/lib/community-gateway` or `@/integrations/supabase/client`, so it is re-implemented
   natively against the core gateway helper + native supabase client, not re-exported. No clean class-A full-module
   candidate exists; the pure presentation helpers are mirrored into i18n keys. This is the central class decision
   the prompt requires.
3. **Diary is NOT split further.** Its 3 rows are one web page with a `tab` param; its native files (photo/text/audio
   capture + entry list + feedback) share one subtree, so a sub-split would not keep file subtrees disjoint
   (ledger-findings §4). One native route reads the `tab` param; the three rows flip together.
4. **No new routes / registry / manifest.** These are ports of screens that already exist in `App.tsx` and
   `screens.json` (`source: registry` on every row); adding a native route file is not an `App.tsx` route, so the
   "new page needs screens.json/exclusions.json + screen-manifest + parity rows" rule does not fire — only
   parity-row **status** flips. The lane adds a native route file and a status flip, nothing in
   `src/navigation/registry/`. `parity-scope.json` already maps `/memory` and `/daily-diary` to `memory-diary`.
5. **Diary capture uses native deps** (`expo-image-picker` for photo, an expo audio recorder + native/back-end STT
   for audio), added in the `diary` lane PR to `apps/mobile/package.json` with their permission strings in
   `apps/mobile/app.config.ts` (both in the `diary` lane `paths` only); these replace the web MediaRecorder / Web
   Speech / browser Supabase-Storage upload and are class-B, not core-extractable (ledger-findings §3).
6. **Runtime verification is deferred to G1** (owner gate). Lanes land the ports with offline build + fake-gateway
   unit tests green; the simulator/Maestro/screenshot-parity pass — and the diary camera/microphone live exercise —
   is a `next_actor: owner` task recorded in the lane and the staging-tests.json. Matches the program's "fixture /
   fake-gateway tests only until G1" model.

## 5. Test design (per lane)

- **Unit (jest-expo + RNTL, fake gateway):** each screen renders its loaded state from fixture data, its empty state,
  its error state. Memory: overview sections render; timeline list + detail; recall static body + empty state;
  permissions switches read/write. Diary: health-mode entry list load/empty/error, bugs-mode ticket list, text-entry
  save, photo picker invoked (faked) + upload path, entry delete, `tab` switch health↔bugs. No network — the
  gateway/core hooks, the image picker and the audio recorder are mocked with fixtures.
- **i18n/RTL:** a test asserts no hardcoded user-visible string in the lane's screens and no physical `left`/`right`;
  renders one screen under `ar` (RTL) and asserts start/end usage. New keys DE-first (du-form; pt você-form).
- **Typecheck/bundle/deps:** `npm run typecheck`, `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` from `apps/mobile/`.
- **Parity / closure:** `node scripts/native/parity-ledger.mjs --check` (rows `native`, routes present) and
  `node scripts/native/core-closure.mjs --check` from the repo root.
- **Deferred (G1, `next_actor: owner`):** Maestro journeys `maestro/<lane>/*.yaml`, iOS simulator + Android emulator
  screenshots at the device sizes, screenshot parity vs the 390×844 read-only staging web screen (for `diary` the
  live camera/microphone capture exercise), listed in `docs/validation/<VTID>/staging-tests.json`.

## 6. Open items for the owner / sparring

- G1 isolated test environment (program gate) is required before any device-runtime parity check — including the
  diary camera/microphone capture path; until then the deferred tasks stay `next_actor: owner`.
- The exact native audio-capture dependency (`expo-audio` vs `expo-av`) and the native STT provider — the `diary`
  lane picks the one consistent with the rest of `apps/mobile/` at implementation time.
- macOS minutes / G3 for iOS-on-device screenshots (program STATUS row 8b) — not needed for the JS build.
