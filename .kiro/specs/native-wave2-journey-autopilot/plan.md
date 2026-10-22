# Plan — native-wave2-journey-autopilot
Author: Kiro, seat `exafyltd`. Repo: `exafyltd/vitana-v1` (native app only — `apps/mobile/**`, `packages/core/**`
via the manifest/closure process, `apps/mobile/parity/ledger.json`, DE-first i18n shards, `docs/validation/**`; no
backend, no gateway change, no migration). Spec: `requirements.md`, `design.md`, `tasks.md`, `lanes/*.md` in this
folder. Program: `docs/programs/native-app/NATIVE-APP-PLAN.md` (VTID-05021), §5 Wave 2.
<!-- plan:begin -->
## Cross-repo sparring
This plan's implementation lives in `exafyltd/vitana-v1` (native app `apps/mobile/**`, `packages/core/**`, the parity
ledger, i18n shards), while the plan PR itself is in `exafyltd/vitana-platform`. Every load-bearing premise the
sparring partner must verify — the class-A/class-B classification of `src/lib/horizonBuckets.ts` and
`src/lib/vitana-projection.ts`, the `packages/core/manifest.json` autopilot type re-export, the parity-ledger rows and
`src/App.tsx` routes — is a vitana-v1 file, read through the `spar_refs` (`exafyltd/vitana-v1: main`) declared in
`handoff.md`.

## Sparring status
Rounds 1–2 ran blind: `spar_refs` is applied only at `client.create`, so the in-progress round-1 session could never
acquire vitana-v1 read access (`responses-2.md`, finding R2-F1). A fresh session is required so the partner can verify
the frontend premises; this plan-text change sets up the `replan` path (a changed plan on an escalated, non-infra
session creates a new session with `spar_refs` applied).
## Goal
Wave 2 screen-port batch of the native Maxina app: port the My Journey / guided-mode / autopilot cluster — the 2
web destinations the parity ledger assigns to `"lane": "journey-autopilot"` — to the native app (`apps/mobile/`) at
1:1 parity with today's **mobile web** screens, built on `@vitana/core` + `@vitana/tokens` + the N2 UI kit
(`@vitana/ui`) on the Wave 1 N3 shell, with fixture / fake-gateway unit tests. Does **not** need G1 planned or built
to land the ports; every device-runtime verification step is marked depends-on-owner (G1). No redesign (program §4),
no new web screen, no `App.tsx` route, no registry/manifest change — only native route files and parity-row status
flips.
## Measured state (worktree = origin/main, parity ledger `apps/mobile/parity/ledger.json` version 2)
- **2 rows** carry `"lane": "journey-autopilot"`, **both `status: "not_started"`** (1 `screen` from `registry`:
  `AUTOPILOT.MY_JOURNEY /autopilot`; 1 `route` from `exclusion`: `/autopilot/audiobook`); **435 rows total**. Counted
  with `node -e` over the committed ledger (the `--report` CLI needs `typescript`, not installed in this worktree).
  `scripts/native/parity-scope.json` labels the lane "Journey / Guided / Autopilot" (`:6`), prefix-maps `/autopilot`
  → `journey-autopilot` (`:109`), marks `/autopilot/audiobook` `scope: in` (`:77`); the audiobook row is also in
  `src/navigation/registry/exclusions.json:211`. The 2 rows and their web paths are listed in `requirements.md`
  R0.2–R0.3.
- Web sources verified present with line counts: `src/pages/AutopilotDashboard.tsx` (605; route `src/App.tsx:1538-1543`
  for `/autopilot`, `:1544-1548` for `/autopilot/audiobook` — both render `AutopilotDashboard`), journey components
  `components/journey/GuidedModeSwitch.tsx` (39), `GuidedJourneyCatalog.tsx` (691), goal/dream north-star + preview
  tiles + goal sheets; the autopilot popup `components/AutopilotPopup.tsx` (717); app-wide providers
  `context/GuidedModeProvider.tsx` (221), `context/AudiobookPlayerProvider.tsx` (528); the mini-player
  `components/audiobook/AudiobookMiniPlayer.tsx` (259); pure helpers `lib/horizonBuckets.ts` (122) and
  `lib/vitana-projection.ts` (122). (These line counts are an **approximate** snapshot for scoping — exact counts are
  not load-bearing. The load-bearing checks — which modules are IO-free (class A) vs class-B — are confirmed at the
  pinned commit: `horizonBuckets.ts` and `vitana-projection.ts` have no `@/integrations/supabase/client` and no
  `@/lib/community-gateway` import, so they extract as class A; every hook/provider in the cluster runtime-imports
  `community-gateway` (`getAccessToken` + `fetch`) or the supabase client, so each is class B and is re-implemented
  natively, never extracted.)
- Wave 1 is on main: N3 shell + resolver route (`apps/mobile/app/(app)/[...path].tsx`, VTID-05186), N2 UI kit
  (`@vitana/ui`, VTID-05176), N1 `@vitana/core`/`@vitana/tokens` (VTID-05183). Ports and conventions in
  `apps/mobile/README.md`. The native app has no production profile; `assertNotProduction()` refuses prod/staging hosts.
## Decisions (made by Kiro as planner under the owner's "finish the native apps" instruction; sparring may revise)
1. **Two disjoint lanes by surface.** The ledger assigns this cluster exactly 2 rows; the prompt asks for 2–3 lanes,
   and 2 is the honest count. Both rows render the same web page (`AutopilotDashboard.tsx`), so the split is by
   surface: **`journey`** (the `/autopilot` My Journey dashboard screen — which hosts guided-mode, the guided-journey /
   teacher catalog, and the autopilot popup) and **`autopilot-audiobook`** (the `/autopilot/audiobook` push deep-link
   route + the native audiobook player). The two touch disjoint route files (`app/(app)/autopilot/index.tsx` vs
   `audiobook.tsx`) and component folders (`src/screens/journey/` vs `src/screens/audiobook/`), build/review
   independently, each leaves the app buildable. A third lane (splitting guided-mode/teacher out) was rejected: those
   are sections of the one `/autopilot` screen, not separate ledger rows, so a third lane would overlap the dashboard's
   file ownership.
2. **Only the two pure IO-free helpers move into `@vitana/core`; every hook/provider is re-implemented natively**
   (R1.4, R1.5). Core gets re-export entries for exactly `horizonBuckets` and `vitana-projection` — both pure (no
   supabase client, no `community-gateway`). `src/types/autopilot.ts` is already a type-only core re-export
   (`packages/core/manifest.json:59`) and is reused. **Every data-fetching hook / provider is NOT moved into core** —
   `use-autopilot.ts` runtime-imports `@/integrations/supabase/client` (`:4`) and `GuidedModeProvider.tsx`,
   `useGuidedJourneyProgress.ts`, `useMyJourney.ts`, `journeyPractice.ts`, `AudiobookPlayerProvider.tsx` all
   runtime-import `@/lib/community-gateway` (IO) — moving any of them into core would pull a class-B file into the
   `core-closure.mjs` BFS and fail `--check` (`m.own !== 'A'`). Instead each lane **re-implements the fetching and
   state natively** (native Supabase client + native auth context + native gateway fetch on the ports) and consumes the
   pure helpers + types from core. HARD RULE honoured: never move a module that runtime-imports the supabase client or
   an IO module into `@vitana/core`; hooks are re-implemented, not extracted. **The core-extraction work is owned by
   the `journey` lane** (its PR adds `packages/core/src/{horizonBuckets,vitana-projection}.ts` re-exports + the
   matching `packages/core/manifest.json` lines, and **in the same PR** runs `node scripts/native/core-closure.mjs
   --write` and commits the regenerated `packages/core/closure.generated.json` and
   `scripts/native/mobile-ci-paths.generated.json`, so `--check` passes). `autopilot-audiobook` consumes core but adds
   no core entry.
3. **The dashboard screen has one owner (`journey`); `autopilot-audiobook` renders it via a port** and overlays the
   native mini-player, so the two `app/(app)/autopilot/*.tsx` files stay disjoint and the dashboard body is not
   duplicated. Therefore **`autopilot-audiobook` depends_on `journey`**; `journey` has no deps.
4. **No new routes / registry / manifest.** Ports of a screen already in `App.tsx` + `screens.json` (+ the audiobook
   exclusion row already in `exclusions.json`); a native Expo Router file is not an `App.tsx` route, so the "new page
   needs screens.json/exclusions.json + screen-manifest + parity rows" rule does not fire — only parity-row **status**
   flips (`not_started`→`in_progress`→`native`).
5. **Device-runtime verification deferred to G1** (owner gate). Lanes land with offline build + fake-gateway unit
   tests green; the Maestro / simulator / screenshot-parity pass — and, for the audiobook lane, actual audio playback,
   which needs a device audio route — is a `next_actor: owner` task recorded in the lane and `staging-tests.json`.
   Matches the program's "fixture / fake-gateway tests only until G1" model.
6. **Mobile-web parity, not desktop.** Each native screen mirrors the `useIsMobile()` ≤ 1024 px branch of its source
   (program §1 shell), composed through N3/N2, every visual value from `@vitana/tokens`; the four N2-documented web
   defects are not reproduced and no web file is touched beyond a DE-first i18n key and a `@vitana/core` re-export line.
   The dashboard is the `dashboard` Spotlight archetype (one hero `spotlight` card + `standard` tiles).
7. **AI-content locale.** Goal-plan generation (`useGenerateGoalPlan`) and any guided-journey / teacher LLM call on the
   user's behalf carry the user's preferred language (R2.5, CLAUDE.md AI-content i18n rule): the native port passes the
   user locale through the same gateway request so the backend injects it; the port adds no English-only system prompt.
## Lanes (all `ready`, executor kiro; seat → reviewer_seat; `vtid:` filled by CI on convergence)
| Lane | Seat → reviewer | Scope (web destinations) | depends_on |
|---|---|---|---|
| `journey` | exafyltd → hotmail | `AUTOPILOT.MY_JOURNEY /autopilot` — the My Journey dashboard, guided-mode switch, guided-journey/teacher catalog, autopilot popup, goal/dream north-star + preview tiles + goal sheets (1 row); **AND owns the core extraction** — `packages/core/src/{horizonBuckets,vitana-projection}.ts` re-exports + `packages/core/manifest.json` lines, with `core-closure.mjs --write` run and `packages/core/closure.generated.json` + `scripts/native/mobile-ci-paths.generated.json` committed in the same PR (decision 2) | — |
| `autopilot-audiobook` | exafyltd → hotmail | `/autopilot/audiobook` — the push deep-link route that starts the audiobook player and settles on `/autopilot`, plus the native audiobook player + mini-player + reminder control (1 row) | `journey` |
Exact `paths` globs are in each `lanes/<id>.md`; the 2 parity rows partition **1 (journey) + 1 (autopilot-audiobook)**
with 0 overlap and 0 orphan; each is an exact `shapeOf` match (not prefix — `parity-ledger.mjs`), so the two lanes'
route files are independent even though they share the `app/(app)/autopilot/` directory. `journey` runs first;
`autopilot-audiobook` waits for `journey` (the dashboard screen it renders through a port).
## Test plan
- **Per lane, offline (fixture / fake gateway, no network):** from `apps/mobile/` — `npm run typecheck`, `npm test`
  (jest-expo + RNTL: loaded/empty/error per screen; journey dashboard section composition, guided-mode toggle via the
  native provider stub, catalog topic/teacher rows, autopilot popup open + snooze/dismiss persistence, goal-plan sheet;
  audiobook episodes loaded/empty/error, play/pause/seek, deep-link starts player + redirects to `/autopilot`, mini
  -player; i18n no-raw-text + RTL start/end; React 19 `ReactElement`), `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check`. From the repo root —
  `node scripts/native/parity-ledger.mjs --check` (rows `native`, routes present).
- **Core extraction deliverable (journey lane): run `--write` AND commit the generated files, not just `--check`.**
  The PR that adds the `horizonBuckets`/`vitana-projection` re-export entries to `packages/core/src/` MUST also run
  `node scripts/native/core-closure.mjs --write` and commit the regenerated `packages/core/closure.generated.json` and
  `scripts/native/mobile-ci-paths.generated.json` in the SAME PR, then `node scripts/native/core-closure.mjs --check`
  passes. Without the `--write`+commit, `--check` fails in NATIVE-CI with "stale generated file" regardless of whether
  the modules are class A. (Confirmed IO-free premise: at the pinned commit both helpers import no
  `@/integrations/supabase/client` and no `@/lib/community-gateway`, so after `--write` the core copies are class A.)
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- **i18n:** 11 locales (ar de en es fr pl pt ru sr tr zh), any new key DE-first (du-form) then mirrored, in the native
  shard `src/i18n/*/journeyAutopilotNative.json`; RTL (`ar`) rendered per screen. AI-content locale injected (decision 7).
- **Deferred to G1 (owner gate, `next_actor: owner`):** Maestro `maestro/<lane>/*.yaml`, iOS simulator + Android
  emulator screenshots at the device sizes, screenshot parity vs the 390×844 **read-only** staging web screen, and
  (audiobook lane) audio playback on a device/simulator with an audio route; listed in
  `docs/validation/<VTID>/staging-tests.json` (sign in, navigate, read; network guard aborts every non-GET except
  sign-in; never `vitanaland.com`). STAGING-VERIFY is read-only by construction (program §6).
- **No What's New entry** (ports of existing screens). No new routes → no nav-registry change and no new native parity
  row — only status flips.
## Open owner / sparring items (not decided here)
- G1 isolated test environment (program gate) — required before any device-runtime parity check; the deferred tasks
  stay `next_actor: owner` until it exists. Audiobook audio playback is the most device-bound of the deferred checks.
- macOS minutes / G3 for iOS-on-device screenshots (program STATUS row 8b) — not needed for the JS build.
- Whether the native audiobook player belongs in `autopilot-audiobook` (this plan's default) or should be a shared
  app-wide shell concern — default here: `autopilot-audiobook` owns it, the cluster that the deep-link row names.
<!-- plan:end -->
