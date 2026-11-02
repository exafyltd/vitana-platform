# Requirements — Native Wave 2: Journey / Guided mode / Autopilot screen ports (native-wave2-journey-autopilot-r2)
Wave 2 screen-port batch of the Maxina native app program
(`docs/programs/native-app/NATIVE-APP-PLAN.md`, program VTID-05021). Port the My Journey / guided-mode / autopilot
cluster — the destinations the parity ledger assigns to the `journey-autopilot` lane — to the native app
(`apps/mobile/`) at 1:1 parity with today's **mobile web** screens, built on `@vitana/core` + `@vitana/tokens`
+ the N2 UI kit (`@vitana/ui`) on the N3 shell. Fixture / fake-gateway tests only; runtime verification on a device
needs the isolated test environment G1 and is called out per task as `depends-on-owner`.
Measured on the worktree (= `origin/main`), parity ledger `apps/mobile/parity/ledger.json` version 2:
**2 rows carry `"lane": "journey-autopilot"`, every one `status: "not_started"`** (1 `screen` from `registry`,
1 `route` from `exclusion`; 435 rows total). Counted with `node -e` over the committed ledger JSON (the `--report`
command needs `typescript`, which is not installed in this worktree). `scripts/native/parity-scope.json` labels the
lane "Journey / Guided / Autopilot" (`:6`), prefix-maps `/autopilot` → `journey-autopilot` (`:109`), and marks
`/autopilot/audiobook` `scope: in` (`:77`). The two lanes below partition those 2 rows with **disjoint `paths`**.
Contract that does not change: `docs/programs/native-app/NATIVE-APP-PLAN.md` §4 (parity method), §6 (verification &
safety), the N2 README web→native prop map (`apps/mobile/README.md` "Web → native prop map"), and the Spotlight /
design rules via tokens. No new web screen, no `App.tsx` route, no `screens.json` / `exclusions.json` entry is added
by this plan (ports only), so no `screen-manifest` or voice-registry change and no new native parity row — only
status flips on existing rows.

## R0 — Scope and the two lanes
0.1 The plan ports exactly the 2 web destinations the parity ledger lists under `"lane": "journey-autopilot"`, split
into two disjoint lanes by surface. No row is in two lanes; no row in scope is left without a lane. Both rows render
the same web page `src/pages/AutopilotDashboard.tsx` (605 lines) — the "My Journey" dashboard — but they are distinct
ledger rows (one registry screen, one push-deep-link exclusion route) and the deep-link route carries its own
audiobook-player start behaviour, so they split cleanly into a dashboard lane and a deep-link/player lane.
0.2 Lane **`journey`** — the My Journey dashboard screen and the guided-mode / autopilot / teacher surfaces it hosts:
`AUTOPILOT.MY_JOURNEY /autopilot` (`kind: screen`, `source: registry`). Web source `src/pages/AutopilotDashboard.tsx`
(605 lines; route `src/App.tsx:1538-1543`). The dashboard composes the goal / dream north-star tiles
(`src/components/journey/GoalNorthStar.tsx`, `DreamNorthStar.tsx`), the guided-mode switch
(`src/components/journey/GuidedModeSwitch.tsx`, 39; VTID-03279), the guided-journey catalog with its teacher / topic
flows (`src/components/journey/GuidedJourneyCatalog.tsx`, 691; VTID-03280), "how it works"
(`JourneyHowItWorks.tsx`), today's-goal / future-self / matches / events / autopilot preview tiles
(`src/components/journey/{TodaysGoalCard,FutureSelfTiles,MatchesPreview,EventsPreview,AutopilotCard}.tsx`), the
goal-setup / goal-plan sheets (`GoalSetupDialog.tsx`, `GoalPlanSheet.tsx`), the autopilot recommendations popup
(`src/components/AutopilotPopup.tsx`, 717), the Vitana Index trajectory card, and the Spotlight `JourneyHero` /
`JourneyRail`. Guided mode is provided app-wide by `src/context/GuidedModeProvider.tsx` (221; VTID-03280). This lane
**owns the core extraction** of the two pure horizon/projection helpers the dashboard uses (R1.4 below).
0.3 Lane **`autopilot-audiobook`** — the audiobook push deep-link route and the native audiobook player it starts:
`/autopilot/audiobook` (`kind: route`, `source: exclusion`; `scripts/native/parity-scope.json:77`,
`src/navigation/registry/exclusions.json:211`). Web route `src/App.tsx:1544-1548` renders the same
`AutopilotDashboard` but the plain path starts the app-wide audiobook player and settles the URL back on `/autopilot`
(VTID-04763). Web sources: the app-wide player provider `src/context/AudiobookPlayerProvider.tsx` (528; VTID-04761),
the mini-player `src/components/audiobook/AudiobookMiniPlayer.tsx` (259), the reminder control
`src/components/audiobook/AudiobookReminderControl.tsx`. This lane re-implements the player + mini-player natively
(`expo-av` / `expo-audio` for playback) and the deep-link route that starts it; it does not re-own the dashboard body
(it renders the `journey` lane's dashboard screen via a port and overlays the mini-player).

## R1 — 1:1 parity with the mobile web screen
1.1 Each native screen mirrors the **mobile web** branch (the `useIsMobile()` ≤ 1024 px branch,
`src/hooks/use-mobile.tsx`) of its web source — same layout, same sections, same navigation, same wording. No
redesign, no added or removed section, no reordering (program §4 "Allowed native improvements only": platform
transitions, gestures, keyboard avoidance, safe areas, haptics, system sheets — nothing else).
1.2 Screens compose through the N3 shell and the N2 UI kit only: `MobileAppShell`, `TopAppBar`, `BottomNav`,
`MobileModePill`, bottom sheets, `VCard`, etc. come from `src/ports/*` (`apps/mobile/README.md` "Ports"); no web
component, no raw colour, every visual value from `@vitana/tokens`. The dashboard is the `dashboard` Spotlight
archetype (one hero KPI card then `standard` tiles — the web screen is `JourneyHero` + `JourneyRail`).
1.3 Web→native translation follows the README map exactly (`onClick`→`onPress`, `className`→`style`,
`toast`→`@vitana/ui/sonner`, documented `Select`/`Tooltip`/close-button/`Slider`/`Progress` differences). The four
web defects the N2 README lists (slider range thumb, progress RTL fill, inert `shouldScaleBackground`, close-button
RTL side) are **not** reproduced — the native kit's corrected behaviour is used, and no web file is touched.
1.4 Business logic, query keys, hooks, types and the pure horizon/projection helpers are reused from `@vitana/core`,
never re-implemented. The two pure, IO-free modules the dashboard uses — `src/lib/horizonBuckets.ts` (122) and
`src/lib/vitana-projection.ts` (122) — are **class-A** (no `@/integrations/supabase/client` and no
`@/lib/community-gateway` runtime import, verified in the web source) and are added to `packages/core/manifest.json`
with a re-export in the `journey` lane's PR, with `node scripts/native/core-closure.mjs --write` run and the
regenerated `packages/core/closure.generated.json` + `scripts/native/mobile-ci-paths.generated.json` committed in the
same PR. `src/types/autopilot.ts` is already a type-only core re-export (`packages/core/manifest.json:59`) and is
reused as-is. **The data-fetching hooks / providers are NOT extracted** (R1.5). `@vitana/core` is the only web→native
bridge; ESLint bans `@/` and relative paths into the web `src/` from app code.
1.5 **Hooks and providers are re-implemented natively on the ports, never extracted.** `use-autopilot.ts` (594)
runtime-imports `@/integrations/supabase/client` (`:4`) and uses `localStorage`; `useMyJourney.ts`,
`useGuidedJourneyProgress.ts`, `journeyPractice.ts`, `GuidedModeProvider.tsx` and `AudiobookPlayerProvider.tsx` all
runtime-import `@/lib/community-gateway` (which imports `getAccessToken` + `fetch`, IO). These are all **class-B**
modules; moving any of them into `@vitana/core` would pull a class-B file into the `core-closure.mjs` BFS and fail
`--check` (`core-closure.mjs`, `m.own !== 'A'`). Each lane re-implements the fetching and the guided-mode / audiobook
state natively (native Supabase client + native auth context + native gateway fetch already on the ports) and consumes
only the pure helpers + types from core. The design names every candidate and its class.

## R2 — i18n (11 locales) + RTL
2.1 Every user-visible string (including `accessibilityLabel` / `accessibilityHint`) comes from the web catalog
shards `src/i18n/<locale>/*.json` (the dashboard's web keys live under `screens.autopilotdashboard.*` in
`src/i18n/de/screens.json` and `src/i18n/de/autopilot.json`), read through the generated catalog map — no hardcoded
text (repo i18n hard rule; `apps/mobile/README.md` "i18n"). Genuinely new native-only strings go in the dedicated
native shard `src/i18n/<locale>/journeyAutopilotNative.json`, DE first then mirrored.
2.2 All 11 active locales resolve: **ar de en es fr pl pt ru sr tr zh** (program §1 design-system note; the live
`supported_locales` table has all 11 `status='ga'`). A new key is added to the **German shard first**
(`src/i18n/de/journeyAutopilotNative.json`) then mirrored to the other ten; DE is du-form.
2.3 Each screen works in RTL (`ar`): `start`/`end`, never `left`/`right`; the shell root `direction` follows the
language (`apps/mobile/README.md` N3 "Theme" row). A test scans the lane's files for physical `left`/`right`.
2.4 Adding a web i18n key is a web-deploy path. A lane that needs a genuinely new string adds the DE key first (in the
native shard) and mirrors it; a lane that can reuse an existing key does so and adds none.
2.5 **AI-generated content must inject the user's locale.** The dashboard's goal-plan generation
(`useGenerateGoalPlan`, `src/hooks/useGoalPlan.ts`) and any guided-journey / teacher LLM call made on the user's
behalf MUST carry the user's preferred language per the CLAUDE.md i18n rule (the backend gateway/edge helper injects
it); the native port passes the user locale through the same request path and does not strip it. The design notes each
LLM call site in the cluster.

## R3 — React 19 / native typing
3.1 React 19 types: no global `JSX` namespace — use `ReactElement` (program hard rule; `.kiro/specs/health-native`
handoff "Hard rules"). `npm run typecheck` (which regenerates the i18n map first) is green.

## R4 — Parity ledger
4.1 Each lane flips its rows from `not_started` to `in_progress` while building and to `native` on completion by
running `node scripts/native/parity-ledger.mjs --sync` (status is edited by hand; `--sync` refreshes derived fields),
and NATIVE-CI `--check` is green: a `native` / `in_progress` row must have a matching route in `apps/mobile/app/`,
and no route in `app/` may lack a row (`scripts/native/parity-ledger.mjs` `check()`). `parity-ledger.mjs` matches by
exact `shapeOf()`, not prefix, so `/autopilot` and `/autopilot/audiobook` are two independent rows that each need
their own native route file flipped to `native`.
4.2 No lane changes `scope`/`lane` of a row (those come from `scripts/native/parity-scope.json`); no lane edits
another lane's rows. The two lanes touch disjoint sets of ledger rows, so the single `ledger.json` file is the one
shared path and conflicts resolve by row.

## R5 — Verification and safety (never production)
5.1 Never test against production; staging specs are read-only (program §6; root `CLAUDE.md`). The native app has
**no production profile** and `assertNotProduction()` refuses the production gateway, `vitanaland.com`, the production
Supabase project and the staging hosts (`apps/mobile/README.md` "No production host, ever").
5.2 Build-time verification per lane is offline: `npm run typecheck`, `npm test` (jest-expo + RNTL unit tests with a
**fake gateway / fixtures**, no network), `APP_PROFILE=development npm run bundle` (Metro + Hermes JS for iOS and
Android), and `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` — all from `apps/mobile/`; plus
`node scripts/native/parity-ledger.mjs --check` from the repo root. No live call is made.
5.3 Runtime parity verification (simulator / emulator screenshots, Maestro device journeys, screenshot parity vs the
390×844 web screen) is a **depends-on-owner (G1)** step: it needs the isolated test environment (and macOS minutes /
G3 for iOS on a device). Each such task is marked `next_actor: owner` in `tasks.md` and the lane records G1 as a
blocker in its log; it does not block the build-time port landing. Audiobook playback especially needs a device /
simulator with an audio route, so the `autopilot-audiobook` lane's playback journey is G1-deferred by construction.
5.4 Each lane adds a read-only `docs/validation/<VTID>/staging-tests.json` for its screens (the VTID is written by CI
after PLAN-SPAR converges). Staging specs sign in, navigate and read; a network guard aborts every non-GET except
sign-in; never `vitanaland.com`.
5.5 No What's New entry (these are ports of existing screens, not new finished features — `CLAUDE.md` What's New rule).

## R6 — Done
6.1 Every in-scope ledger row for the lane is `native` with its native route in `apps/mobile/app/` and its
functional-parity checklist (program §4 per-screen checklist) recorded; RTL (`ar`) covered.
6.2 `npm run typecheck`, `npm test`, `npm run bundle`, `npm run deps:check` and `parity-ledger --check` green;
NATIVE-CI (incl. the shell source-pin and ports checks) and the Collab handoff + Lane scope PR-GATE checks green;
`node scripts/native/core-closure.mjs --check` green (the `journey` lane adds core re-exports).
6.3 `docs/validation/<VTID>/` has `scope.json` (every touched path), `staging-tests.json` (the lane's read-only spec)
and `plan-sparring.md` (copy of this plan's sparring record).

## Out of scope (named so a lane does not drift into them)
- Any screen in another Wave 2 ledger lane. In particular `ASSISTANT.AUTOPILOT /assistant?tab=autopilot` is the
  **`ai`** lane's row (its own plan), not this cluster, even though it shares the "autopilot" word.
- The admin / dev autopilot & journey surfaces — `/admin/autopilot/*`, `/admin/insights/{autopilot-impact,journeys}`,
  `/dev/command/autopilot-runs` — are all `scope: out` (`out:system-browser` / `out:excluded`) in the ledger and are
  rendered through the system browser, not ported.
- G1 / G2 / G3 provisioning, EAS / store build pipelines, the ORB voice module — their own plans / owner gates.
- Any web-side change beyond adding an i18n key (DE first) and a `@vitana/core` re-export line.
