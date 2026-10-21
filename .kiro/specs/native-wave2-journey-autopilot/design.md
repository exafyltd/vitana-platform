# Design — Native Wave 2: Journey / Guided mode / Autopilot screen ports (native-wave2-journey-autopilot)
How the two lanes port the `journey-autopilot` ledger cluster to native. Follows
`docs/programs/native-app/NATIVE-APP-PLAN.md` §3 (architecture) and §4 (parity method), the N3 shell and N2 UI kit
already on main, and `apps/mobile/README.md`. Nothing here changes the program plan or the design contract.

## 1. Where native screens live and how they resolve
Wave 1 N3 (VTID-05186) built the shell and a resolver route: `apps/mobile/app/(app)/[...path].tsx` renders every
ledger destination that is not yet native as "Unported", admin as the web console, unknown as not-found
(`apps/mobile/parity/ledger.json` `native_only` entry for `/*`). Porting a screen means **adding its own Expo Router
file under `apps/mobile/app/`** whose route path equals the web path, so the resolver no longer catches it, the push
`data.url` / universal link / ORB directive resolve the same, and the parity row can go `native`
(`scripts/native/parity-ledger.mjs` `fileToRoute()` maps `app/(app)/foo/index.tsx` → `/foo`).
Route-file plan (Expo Router, paths = web paths):
| Lane | Native route file(s) under `apps/mobile/app/` | Web path(s) |
|---|---|---|
| `journey` | `(app)/autopilot/index.tsx` | `/autopilot` |
| `autopilot-audiobook` | `(app)/autopilot/audiobook.tsx` | `/autopilot/audiobook` |
The two route files sit in the same `app/(app)/autopilot/` folder but are distinct files owned by distinct lanes; the
ledger's shape-matching (`shapeOf`, query dropped) matches `/autopilot` to `index.tsx` and `/autopilot/audiobook` to
`audiobook.tsx` as two independent rows (`parity-ledger.mjs` matches exact shape, not prefix — the audiobook row is
never "covered under `/autopilot`"). To keep file ownership disjoint, the shared dashboard **screen component** lives
in the `journey` lane's `apps/mobile/src/screens/journey/` folder; the `autopilot-audiobook` route renders it through
a port and overlays the native mini-player, so the two lanes' `apps/mobile/app/` and `apps/mobile/src/screens/`
subtrees do not overlap.

## 2. Screen source: the N2/N3 structure, not the web DOM
Each lane re-implements the **mobile web** branch of its source screen with React Native primitives:
- Imports go through ports only: `@vitana/core/*` (types, query keys, the pure horizon/projection helpers),
  `@vitana/ui` (UI kit), `@vitana/tokens` (visual values), `src/ports/*` from the shell (`core`, `ui`, `links`,
  `badges`, `soundscape`, `orb-slot`). No `@/…` web import (ESLint-banned in app code).
- The web→native prop map (`apps/mobile/README.md`) is mechanical: `onClick`→`onPress`, `className`→`style`,
  shadcn `Card`→`VCard`/`Panel`, `Dialog`/`Sheet`/`ResponsiveDialog`→the kit's modal / bottom sheet,
  `toast`/`notify*`→`@vitana/ui`/`@vitana/ui/sonner`, list/scroll→`FlatList`/`ScrollView`.
- Mobile patterns already in the shell are reused: `MobileModePill` (the web `UtilityActionButton` dropdown,
  `AutopilotDashboard.tsx:18`), header chips (`VitanaIndexChip`, `AutopilotChip`, `AutopilotDashboard.tsx:22`).

### 2a. Journey lane specifics (the dashboard is the hard part)
`AutopilotDashboard.tsx` (605) is a composed dashboard, not a single list. The native My Journey screen
(`apps/mobile/src/screens/journey/JourneyScreen.tsx`) mirrors the mobile-web branch section by section:
- **Hero / north-star:** the Spotlight `JourneyHero` + goal / dream north-star (`GoalNorthStar`, `DreamNorthStar`)
  as the single `spotlight` `VCard` (dashboard archetype SR-06); the Vitana Index trajectory card demoted beside it.
- **Guided mode:** the `GuidedModeSwitch` (39-line toggle) backed by a **native re-implementation** of
  `GuidedModeProvider` (221) — the provider runtime-imports `@/lib/community-gateway` (`:32`) and uses `localStorage`
  (`:86-106`), so it is class-B and NOT extracted; the native version uses the native auth context + native gateway
  fetch + the native key-value cache already on the ports, preserving the same mode-cache-then-resolve behaviour.
- **Guided journey catalog + teacher / topic flows:** `GuidedJourneyCatalog` (691) is the catalog of guided topics and
  the teacher flow entry points; it is re-implemented natively as `VCard` rows, its data fetched through the native
  gateway (the web component's fetching is class-B). Progress is the native twin of `useGuidedJourneyProgress` (362),
  which uses `communityFetch` + `localStorage` — re-implemented natively, never extracted.
- **Preview tiles:** today's-goal, future-self, matches, events and autopilot preview tiles
  (`TodaysGoalCard`, `FutureSelfTiles`, `MatchesPreview`, `EventsPreview`, `AutopilotCard`) become `standard` `VCard`
  tiles; matches/events previews deep-link into the `community`/`events` native routes by path only (those rows are
  other lanes' — linked, not owned).
- **Autopilot recommendations popup:** `AutopilotPopup` (717) + `use-autopilot` (594, runtime-imports
  `@/integrations/supabase/client:4`, class-B) become a native bottom sheet backed by a native re-implementation of
  the autopilot hook (native Supabase client on the ports). The snooze/dismiss state (web `localStorage`) uses the
  native key-value store.
- **Goal setup / plan sheets:** `GoalSetupDialog` / `GoalPlanSheet` → the kit's bottom sheet; goal-plan generation
  (`useGenerateGoalPlan`, `src/hooks/useGoalPlan.ts`) is an **LLM call on the user's behalf** — the native request
  passes the user's preferred language so the backend injects it (R2.5, CLAUDE.md AI-content i18n rule).
- **Pure helpers via core:** horizon bucketing (`bucketFromWaveId`, `src/lib/horizonBuckets.ts`, 122) and the
  7-day trend / projection (`trend7d`, `src/lib/vitana-projection.ts`, 122) are pure/IO-free and are the two modules
  this lane re-exports through `@vitana/core` (decision 2); `src/types/autopilot.ts` is already a core type re-export
  and is reused.

### 2b. Autopilot-audiobook lane specifics
The `/autopilot/audiobook` plain path is a **push deep link** (VTID-04763) that starts the app-wide audiobook player
and settles the URL on `/autopilot` (web `src/App.tsx:1544-1548` renders `AutopilotDashboard`; the player is started
app-wide by `AudiobookPlayerProvider`, `src/context/AudiobookPlayerProvider.tsx:135`). Native port:
- `apps/mobile/app/(app)/autopilot/audiobook.tsx` renders the `journey` lane's dashboard screen **via a port** (no
  duplicate dashboard) and, on mount, starts the native audiobook player and redirects the route to `/autopilot` —
  the same "start player, settle on /autopilot" behaviour.
- The player itself is a **native re-implementation** of `AudiobookPlayerProvider` (528) — it runtime-imports
  `@/lib/community-gateway` (`:33`, class-B), so it is NOT extracted; the native provider fetches episodes through the
  native gateway and plays via `expo-av` / `expo-audio` (program library map §3, web `<audio>`→native audio). The
  native mini-player (`apps/mobile/src/screens/audiobook/AudiobookMiniPlayer.tsx`) is the twin of
  `src/components/audiobook/AudiobookMiniPlayer.tsx` (259) and the reminder control twin of `AudiobookReminderControl`.
- This lane owns `apps/mobile/src/screens/audiobook/` and the `audiobook.tsx` route file only; it imports the
  dashboard screen from `journey` through a port, so **`autopilot-audiobook` depends_on `journey`**.

## 3. Disjointness (no overlap, no orphan)
- **Ledger rows:** the 2 `journey-autopilot` rows partition cleanly — `journey` 1 (`AUTOPILOT.MY_JOURNEY /autopilot`),
  `autopilot-audiobook` 1 (`/autopilot/audiobook`). 1 + 1 = 2. Each row named explicitly in the lane file.
- **Native files:** `journey` owns `apps/mobile/app/(app)/autopilot/index.tsx` and `apps/mobile/src/screens/journey/`;
  `autopilot-audiobook` owns `apps/mobile/app/(app)/autopilot/audiobook.tsx` and `apps/mobile/src/screens/audiobook/`.
  No file is in two lanes (the two share the `app/(app)/autopilot/` directory but own different files in it).
- **Tests:** each lane owns its screen test files and its `docs/validation/<VTID>/` folder.
- **Shared, by-row-not-by-file:** `apps/mobile/parity/ledger.json` (each lane edits only its own row),
  `packages/core/manifest.json` + `packages/core/src/**` closure (only the `journey` lane adds re-exports — the two
  pure helpers), and the DE-first i18n shard `src/i18n/*/journeyAutopilotNative.json` (each lane adds only its keys).
  These are listed in each lane's `paths`.

## 4. Decisions (made by Kiro as planner; sparring may revise)
1. **Two lanes, not one or three.** The ledger assigns this cluster exactly 2 rows. The prompt asks for 2–3 disjoint
   lanes; 2 is the honest count here. The split is by surface: `journey` (the My Journey dashboard screen, which hosts
   guided-mode, the guided-journey/teacher catalog and the autopilot popup) and `autopilot-audiobook` (the push
   deep-link route + the native audiobook player). Rationale: the two touch disjoint route files and component folders,
   can be built and reviewed independently, and each leaves the app buildable. A third lane was considered (splitting
   guided-mode/teacher out of the dashboard) and rejected: they are sections of the one `/autopilot` screen, not
   separate ledger rows or routes, so a separate lane would overlap the dashboard's file ownership.
2. **Only the two pure helpers move into `@vitana/core`; every hook/provider is re-implemented natively.**
   `horizonBuckets.ts` and `vitana-projection.ts` are IO-free (no `@/integrations/supabase/client`, no
   `@/lib/community-gateway`, verified in the web source) → class-A → re-exported through core. All of
   `use-autopilot.ts` (→ supabase client), `GuidedModeProvider.tsx`, `useGuidedJourneyProgress.ts`, `useMyJourney.ts`,
   `journeyPractice.ts`, `AudiobookPlayerProvider.tsx` (→ `community-gateway`, i.e. `getAccessToken` + `fetch`) are
   **class-B** and are re-implemented natively on the ports (program §3 extraction model; hard rule: never move a
   module that runtime-imports the supabase client or an IO module into core). Re-implementing the fetching natively
   avoids forking the pure ranking/bucket logic (that stays single-sourced in core) while keeping the IO on the
   native ports.
3. **The dashboard screen has one owner (`journey`); `autopilot-audiobook` consumes it via a port.** So the two
   `app/(app)/autopilot/*.tsx` files are disjoint and the audiobook route does not duplicate the dashboard body.
   `autopilot-audiobook` depends_on `journey`.
4. **No new routes / registry / manifest.** These are ports of a screen that already exists in `App.tsx` and
   `screens.json` (+ the audiobook exclusion row already in `exclusions.json:211`); adding a native route file is not
   an `App.tsx` route, so the "new page needs screens.json/exclusions.json + screen-manifest + parity rows" rule does
   not fire — only parity-row **status** flips. The lane adds a native route file and a status flip, nothing in
   `src/navigation/registry/`.
5. **Runtime verification is deferred to G1** (owner gate). Lanes land the ports with offline build + fake-gateway
   unit tests green; the simulator/Maestro/screenshot-parity pass — and audiobook audio playback, which needs a device
   audio route — is a `next_actor: owner` task recorded in the lane and the `staging-tests.json`. This matches the
   program's "fixture / fake-gateway tests only until G1" model (`.kiro/specs/health-native` handoff,
   `native-g1-wiring`).
6. **AI-content locale.** Goal-plan generation and any guided-journey / teacher LLM call made on the user's behalf
   carry the user's preferred language (R2.5): the native port passes the user locale through the same gateway request
   so the backend's `buildLocalizedSystemPrompt` injects it; the port adds no English-only system prompt.

## 5. Test design (per lane)
- **Unit (jest-expo + RNTL, fake gateway):** each screen renders its loaded state from fixture data, its empty state,
  its error state. For `journey`: the dashboard composes each section (north-star, guided-mode switch toggles mode via
  the native provider stub, catalog renders topic/teacher rows, preview tiles render, the autopilot popup opens and
  snooze/dismiss persists to the native KV stub, goal-plan sheet opens); the pure `horizonBuckets` / `vitana-projection`
  helpers get pure-module tests through their core entry. For `autopilot-audiobook`: the deep-link route starts the
  player (native player stub), redirects to `/autopilot`, and the mini-player renders play/pause/seek from fixture
  episodes, empty and error states. No network — the gateway/core hooks are mocked with fixtures.
- **i18n/RTL:** a test asserts no hardcoded user-visible string in the lane's screens and no physical `left`/`right`;
  renders one screen under `ar` (RTL) and asserts start/end usage.
- **Typecheck/bundle/deps:** `npm run typecheck`, `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` from `apps/mobile/`.
- **Parity:** `node scripts/native/parity-ledger.mjs --check` from the repo root (rows `native`, routes present).
- **Core (journey only):** `node scripts/native/core-closure.mjs --write` run and the generated files committed, then
  `--check` green.
- **Deferred (G1, `next_actor: owner`):** Maestro journeys `maestro/<lane>/*.yaml`, iOS simulator + Android emulator
  screenshots at the device sizes, screenshot parity vs the 390×844 read-only staging web screen, and (for the
  audiobook lane) a device/simulator with an audio route; listed in `docs/validation/<VTID>/staging-tests.json`.

## 6. Open items for the owner / sparring
- G1 isolated test environment (program gate) is required before any device-runtime parity check; until then the
  deferred tasks stay `next_actor: owner`. Audiobook playback is the most device-bound of the deferred checks.
- macOS minutes / G3 for iOS-on-device screenshots (program STATUS row 8b) — not needed for the JS build.
