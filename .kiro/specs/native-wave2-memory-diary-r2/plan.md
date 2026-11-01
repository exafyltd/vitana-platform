# Plan — native-wave2-memory-diary-r2
Author: Kiro, seat `exafyltd`. Repo: `exafyltd/vitana-v1` (native app only — `apps/mobile/**`, `packages/core/**`
via the manifest/closure process, `apps/mobile/parity/ledger.json`, DE-first i18n shards, `docs/validation/**`; no
backend, no gateway change, no migration). Spec: `requirements.md`, `design.md`, `tasks.md`, `lanes/*.md` in this
folder. Program: `docs/programs/native-app/NATIVE-APP-PLAN.md` (VTID-05021), §5 Wave 2. Ledger investigation:
`sparring/ledger-findings.md` (read-only, verified against vitana-v1 origin/main).

<!-- plan:begin -->
## Re-plan
Re-plan of native-wave2-memory-diary (PR #4322, converged) under a new slug; the old branch has commits without Collab trailers.
The content below is the converged plan of `native-wave2-memory-diary` unchanged except the slug. The old plan's VTIDs (VTID-05376, VTID-05377) were written only on the old PR branch, never on `main`; they are to be retired (terminalized `cancelled` by the PM or the exceptions seat once these lanes have their own VTIDs); this plan does not touch the ledger.
Sparring history: https://github.com/exafyltd/vitana-platform/pull/4322 (rounds under `.kiro/specs/native-wave2-memory-diary/sparring/` on the old branch; not copied here). PLAN-SPAR spars this slug as a fresh session.
## Goal
Wave 2 screen-port batch of the native Maxina app: port the memory / diary cluster — the 7 web destinations the
parity ledger assigns to `"lane": "memory-diary"` — to the native app (`apps/mobile/`), built on `@vitana/core` +
`@vitana/tokens` + the N2 UI kit (`@vitana/ui`) on the Wave 1 N3 shell, with fixture / fake-gateway unit tests. The
**diary** screen mirrors its phone-shaped web source (`MobileDailyDiary.tsx`, which renders through `MobileAppShell`)
1:1; the **four memory** screens have no mobile-web branch (they render the responsive desktop `AppLayout` on phones),
so they are **body-ported** — their content, controls and states re-authored through the native N3 shell — not pixel
copies of the responsive desktop layout (decision 6, sparring R1-F1). Does **not** need G1 planned or built to land the ports; every
device-runtime verification step is marked depends-on-owner (G1). No redesign (program §4), no new web screen, no
`App.tsx` route, no `screens.json`/`exclusions.json`/screen-manifest change — only native route files, a DE-first
i18n key (+ mirrors), at most a `@vitana/core` re-export line, and parity-row status flips.

## Measured state (worktree branch = vitana-v1 origin/main; parity ledger `apps/mobile/parity/ledger.json` version 2)
- **7 rows** carry `"lane": "memory-diary"`, **all `status: "not_started"`** (all `kind: screen`, `scope: in`,
  `source: registry`, `exception: null`, `owner: null`); **435 rows total** (version 2). Verified by reading the
  committed ledger at vitana-v1 main (R1-F2): the 7 keys/paths are exactly `MEMORY.OVERVIEW /memory`,
  `MEMORY.TIMELINE /memory/timeline`, `MEMORY.RECALL /memory/recall`, `MEMORY.PERMISSIONS /memory/permissions`,
  `MEMORY.DAILY_DIARY /daily-diary`, `MEMORY.DIARY /daily-diary?tab=health`, `MEMORY.DIARY_BUGS /daily-diary?tab=bugs`,
  and **there is no `/memory/diary` ledger row at all (0 rows)** — so it cannot be an orphan: `/memory/diary` is a
  live route that redirects to `/daily-diary` on mobile (`src/App.tsx:720-727`) and to the desktop Diary hub on
  desktop, and the ledger tracks neither as a `memory-diary` row. The 7 rows and their web paths are also listed in
  `requirements.md` R0.2–R0.3.
- Web sources verified present with line counts (`sparring/ledger-findings.md` §2): `src/pages/Memory.tsx` (124,
  route `src/App.tsx:1605`), `src/pages/memory/Timeline.tsx` (66, `:1610`), `src/pages/memory/Recall.tsx` (350,
  `:1620`), `src/pages/memory/Permissions.tsx` (62, `:1625`), `src/pages/MobileDailyDiary.tsx` (193, `:1120`). The
  `MobileDailyDiary` page backs all three diary rows via the `tab` query param (`?tab=health`/`?tab=bugs`); on mobile
  `/memory/diary` redirects to `/daily-diary` (`src/App.tsx:720-727`), and the desktop hub `src/pages/memory/Diary.tsx`
  (381) is NOT a cluster row.
- Wave 1 is on main: N3 shell + resolver route (`apps/mobile/app/(app)/[...path].tsx`, VTID-05186), N2 UI kit
  (`@vitana/ui`, VTID-05176), N1 `@vitana/core`/`@vitana/tokens` (VTID-05183). Prop map, ports and conventions in
  `apps/mobile/README.md`. The native app has no production profile; `assertNotProduction()` refuses prod/staging hosts.

## Decisions (made by Kiro as planner under the owner's "finish the native apps" instruction; sparring may revise)
1. **Two disjoint lanes by cluster:** **`memory`** (the 4 `/memory*` rows) and **`diary`** (the 3 `/daily-diary*`
   rows). The web path prefixes (`/memory*` vs `/daily-diary*`), the native route subtrees
   (`apps/mobile/app/(app)/memory/**` vs `apps/mobile/app/(app)/daily-diary/**`) and the native screen subtrees
   (`src/screens/memory/**` vs `src/screens/diary/**`) are all disjoint, so the split is clean and each lane builds,
   reviews and lands independently with the app buildable. **Partition:** `memory` 4 rows (`MEMORY.OVERVIEW`,
   `MEMORY.TIMELINE`, `MEMORY.RECALL`, `MEMORY.PERMISSIONS`) + `diary` 3 rows (`MEMORY.DAILY_DIARY`, `MEMORY.DIARY`,
   `MEMORY.DIARY_BUGS`) = **7** = every selected row, each in exactly one lane. **Diary is NOT split further:** its 3
   rows are one web page with a `tab` param and its native files (photo/text/audio capture + entry list) share one
   subtree, so a sub-split would not keep file subtrees disjoint (ledger-findings §4). **0 overlap, 0 orphan.** The
   two lanes have no dependency on each other and run in parallel.
2. **The whole cluster is class-B native re-implementation, NOT core-extraction** (ledger-findings §3, premise
   verified by reading imports). A module is class-B (re-implemented natively, not core-extracted) if it imports
   `@/integrations/supabase/client` or `@/lib/community-gateway` directly or transitively. `@/lib/memory-api`,
   `@/lib/memory-learning-api`, `@/lib/timeline-api` and `@/lib/diary-index-sync` all import
   `@/lib/community-gateway` (`memory-api.ts:8`, `diary-index-sync.ts:1`), so every runtime data path in the cluster
   is class-B: memory garden/add-memory/what-Vitana-knows, learning switches/usage, timeline, and every diary
   capture/entry/feedback module. These are re-implemented natively against the native gateway helper in
   `apps/mobile/src/auth/gateway.ts` (`getGateway()`/`gatewayGet()`, which wrap `@vitana/core/gateway`'s
   `createGatewayFetch`/`gatewayJson` imported via `src/ports/core` — gateway.ts does not itself export those two
   symbols) and the native Supabase client reached through the `core` port (`@vitana/core/supabase` →
   `apps/mobile/src/auth/client.ts`; `@supabase/supabase-js` is a native dep but screen code never imports it
   directly, per the ports-only rule) — **not** given a `@vitana/core` re-export. **Active-role header (sparring
   R1-F3, verified):** the web `communityFetch` (`vitana-v1:src/lib/community-gateway.ts:13-15`) sends
   `Authorization: Bearer <token>` **and** `X-Vitana-Active-Role: community` on every call, while the generic native
   `gatewayGet`/`gatewayJson` (`apps/mobile/src/auth/gateway.ts:6`) does not add that role header. So the native
   class-B memory/diary data layer MUST send `X-Vitana-Active-Role: community` (and any other community-gateway
   headers) on every memory/diary gateway call — otherwise native reads/writes could hit the wrong active-role tenant
   scoping. This is implemented as a small community-gateway wrapper in the native data layer (not by changing the
   shared `gatewayGet`), and a fake-gateway unit test asserts the header is present on each memory/diary call (see
   test plan). **No clean full-module class-A re-export exists** in either cluster. The only genuinely pure logic (`timeline-meta.tsx`
   pillar/catalog maps, `routine-text.ts` phrasing, `gardenCategoryKey`, `formatIndexDelta`) is **mirrored** natively
   (into DE-first i18n keys and small native helpers), not re-exported, because it either pulls web-only deps
   (`lucide-react`, `@/hooks/useVitanaIndex`) or lives inside a class-B module. **If** sparring or implementation does
   find a genuinely pure class-A module to promote, the owning lane adds exactly ONE `@vitana/core` re-export in the
   SAME PR: the `packages/core/manifest.json` line + the `packages/core/src/**` re-export + `node
   scripts/native/core-closure.mjs --write` run with the regenerated `packages/core/closure.generated.json` and
   `scripts/native/mobile-ci-paths.generated.json` committed, so `--check` passes. Default: none needed.
3. **Diary capture is native, class-B, with new native deps.** Web photo upload uses **Supabase Storage**; web audio
   capture uses **MediaRecorder + Web Speech / backend STT**. Native re-implements photo with `expo-image-picker`
   (upload still to Supabase Storage) and audio with a native expo audio recorder (`expo-audio`/`expo-av`) +
   native/back-end STT. `expo-image-picker` and the expo audio recorder are **new native deps** not yet in
   `apps/mobile/package.json`; the `diary` lane adds them in its PR. None of this is core-extractable.
   **The same `diary` PR registers both as Expo config plugins in `apps/mobile/app.config.ts`** (the app has no
   `app.json`; `app.config.ts` is in the `diary` lane's `paths`, r2 sparring R1-F1): `expo-image-picker` with
   its `photosPermission` and `cameraPermission` strings (iOS `NSPhotoLibraryUsageDescription`,
   `NSCameraUsageDescription`) and the chosen audio package (`expo-audio` or `expo-av`) with its
   `microphonePermission` string (`NSMicrophoneUsageDescription`; Android `RECORD_AUDIO` / camera / media
   permissions come from the same plugins). Without them a development EAS build lacks the usage descriptions and iOS
   terminates the app on first camera/microphone access. The permission texts are DE-first and come from the lane's
   `src/i18n/*/diaryNative.json` shard (read by `app.config.ts`); per-locale `InfoPlist` localisation is checked
   on the G1 device build (decision 5). A unit test evaluates the resolved Expo config
   (`APP_PROFILE=development`) and asserts the three iOS usage-description keys and both plugins are present, so the
   offline lane checks catch a missing entry before any device build.
4. **No new routes / registry / manifest.** All 5 distinct web routes (`/memory`, `/memory/timeline`,
   `/memory/recall`, `/memory/permissions`, `/daily-diary`) already exist in `src/App.tsx`; the destinations are
   already registry screens (`source: registry` on every row). A native Expo Router file is not an `App.tsx` route,
   so the "new page needs screens.json/exclusions.json + screen-manifest + parity rows" rule does not fire — only
   parity-row **status** flips (`not_started`→`in_progress`→`native`). `scripts/native/parity-scope.json` already
   maps `/memory` and `/daily-diary` to lane `memory-diary` — no scope edit (ledger-findings §5).
5. **Device-runtime verification deferred to G1** (owner gate). Lanes land with offline build + fake-gateway unit
   tests green; the Maestro / simulator / screenshot-parity pass is a `next_actor: owner` task recorded in the lane
   and `staging-tests.json`. For `diary`, the live exercise of the camera/microphone capture path is part of that G1
   task — the offline unit tests fake the picker/recorder. Matches the program's "fixture / fake-gateway tests only
   until G1" model.
6. **Parity target — corrected per sparring R1-F1 (the two sub-clusters differ):**
   - **Diary (`/daily-diary*`, 1 web page):** `src/pages/MobileDailyDiary.tsx` IS the phone-shaped web source — it
     renders through `MobileAppShell` (verified: `MobileDailyDiary.tsx` imports/uses `MobileAppShell`). The native
     diary screen mirrors that mobile-web source 1:1, composed through N3/N2, every visual value from `@vitana/tokens`.
   - **Memory (`/memory`, `/memory/timeline`, `/memory/recall`, `/memory/permissions`):** these 4 pages have **no
     `useIsMobile()` branch and do not use `MobileAppShell`** — verified against vitana-v1 main:
     `src/pages/Memory.tsx:11`, `src/pages/memory/Timeline.tsx:14`, `src/pages/memory/Recall.tsx:3`,
     `src/pages/memory/Permissions.tsx:9` all import `AppLayout` + `SubNavigation` (+ `ScreenFrame`/spotlight) and
     render that responsive desktop chrome on phones. **There is no distinct "mobile-web" branch to mirror for these
     four.** So the parity target for the memory lane is **option (a): port the screen BODY content (the data,
     controls, states a member interacts with) and compose it through the native N3 shell (`MobileAppShell`
     substitutes for the responsive web `AppLayout`/`SubNavigation`), re-authored natively, not a pixel copy of the
     responsive desktop layout.** The reference for "correct" is functional parity of the body (same data read via
     the class-B native layer, same controls/empty/error states, same navigation targets), NOT a 390×844 web
     screenshot — a 390×844 capture of these pages shows the responsive desktop `AppLayout` nav, which a native shell
     deliberately does not reproduce (the sidebar/ORB/chrome come from N3). The memory lane's G1 screenshot task
     therefore compares the native screen against the **native N3 shell baseline for body parity**, not against a
     web capture; this is recorded in the memory lane file and its `staging-tests.json` so the reviewer does not
     expect a web↔native pixel match for the four memory rows. Recall (`src/pages/memory/Recall.tsx`) has a static
     mock body + honest empty state (`SpotlightEmpty`) — it ports as a pure presentational screen body, re-authored
     natively, not core-extracted. In all cases the N2-documented web defects are not reproduced and no web file is
     touched beyond a DE-first i18n key (+ mirrors) and — only if decision 2's pure-module case materialises — a
     `@vitana/core` re-export line.

## Lanes (all `ready`, executor kiro; seat → reviewer_seat; `vtid:` filled by CI on convergence)
| Lane | Seat → reviewer | Scope (web destinations) | depends_on |
|---|---|---|---|
| `memory` | exafyltd → hotmail | `MEMORY.OVERVIEW /memory`, `MEMORY.TIMELINE /memory/timeline`, `MEMORY.RECALL /memory/recall`, `MEMORY.PERMISSIONS /memory/permissions` (**4 rows**) | — |
| `diary` | exafyltd → hotmail | `MEMORY.DAILY_DIARY /daily-diary`, `MEMORY.DIARY /daily-diary?tab=health`, `MEMORY.DIARY_BUGS /daily-diary?tab=bugs` — one web page via the `tab` param, one native route, all 3 rows flip together; adds native deps `expo-image-picker` + expo audio recorder (**3 rows**) | — |
Exact `paths` globs are in each `lanes/<id>.md`; the 7 parity rows partition **4 (memory) + 3 (diary)** with 0
overlap and 0 orphan (ledger-findings §4). Native route subtrees (`app/(app)/memory/**` vs
`app/(app)/daily-diary/**`) and screen subtrees (`src/screens/memory/**` vs `src/screens/diary/**`) are disjoint.
The two lanes have no dependency on each other and run in parallel.

## Test plan
- **Per lane, offline (fixture / fake gateway, no network):** from `apps/mobile/` — `npm run typecheck`, `npm test`
  (jest-expo + RNTL: loaded/empty/error per screen; memory overview + timeline + recall-static-body + permissions
  switches; diary health-mode entries + bugs-mode ticket list + text save + photo picker invoked + entry delete +
  tab switch; **active-role header (R1-F3): a fake-gateway test asserts every memory/diary gateway call carries
  `X-Vitana-Active-Role: community`** (and the Bearer token), matching web `communityFetch`; i18n no-raw-text + RTL
  start/end; React 19 `ReactElement`), `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check`. From the repo root —
  `node scripts/native/parity-ledger.mjs --check` (rows `native`, routes present) and
  `node scripts/native/core-closure.mjs --check`.
- **Core extraction deliverable (only if decision 2's pure-module case materialises):** the lane that adds a
  `@vitana/core` re-export entry MUST also run `node scripts/native/core-closure.mjs --write` and commit the
  regenerated `packages/core/closure.generated.json` and `scripts/native/mobile-ci-paths.generated.json` in the SAME
  PR, then `--check` passes. Default: ledger-findings §3 found no clean full-module class-A candidate, so no re-export
  is expected — the class-B data paths are re-implemented natively against the core gateway helper.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- **i18n:** 11 locales (ar de en es fr pl pt ru sr tr zh), any new key DE-first (du-form; **pt is Brazilian
  Portuguese você-form**) then mirrored; **ar is RTL** — rendered with start/end only, never physical `left`/`right`.
- **Deferred to G1 (owner gate, `next_actor: owner`):** Maestro `maestro/<lane>/*.yaml`, iOS simulator + Android
  emulator screenshots at the device sizes; listed in `docs/validation/<VTID>/staging-tests.json` (sign in, navigate,
  read; network guard aborts every non-GET except sign-in; never `vitanaland.com`). **Screenshot-parity reference
  differs by lane (R1-F1):** the **diary** screen compares against the 390×844 **read-only** staging web screen
  (its web source `MobileDailyDiary.tsx` is already phone-shaped via `MobileAppShell`), whereas the **four memory**
  screens have no phone-shaped web source, so their G1 check verifies **body parity against the native N3 shell
  baseline** (same data/controls/states/navigation targets), NOT a web↔native pixel match — a 390×844 web capture of
  these pages shows the responsive desktop `AppLayout` nav, which the native shell deliberately does not reproduce.
  For `diary`, the camera/microphone capture live exercise is also part of this task. STAGING-VERIFY is read-only by
  construction (program §6).
- **No What's New entry** (ports of existing screens). No new routes → no nav-registry change and no new native parity
  row — only status flips.

## Open owner / sparring items (not decided here)
- G1 isolated test environment (program gate) — required before any device-runtime parity check, including the diary
  camera/microphone capture path; the deferred tasks stay `next_actor: owner` until it exists.
- macOS minutes / G3 for iOS-on-device screenshots (program STATUS row 8b) — not needed for the JS build.
- The exact new-dependency choice for native audio capture (`expo-audio` vs `expo-av`) and the native STT provider —
  the `diary` lane picks the one consistent with the rest of `apps/mobile/` at implementation time.
<!-- plan:end -->

<!-- re-trigger after PLAN-SPAR repair; 2026-10-28T09:51:27.8876625+01:00 -->
