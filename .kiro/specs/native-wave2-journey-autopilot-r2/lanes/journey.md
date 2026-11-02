---
lane: journey
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(app)/autopilot/index.tsx
  - apps/mobile/src/screens/journey/**
  - apps/mobile/maestro/journey/**
  - packages/core/manifest.json
  - packages/core/closure.generated.json
  - packages/core/src/**
  - scripts/native/mobile-ci-paths.generated.json
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/parity/ledger.json
  - apps/mobile/tests/journey/**
  - src/i18n/*/journeyAutopilotNative.json
  - docs/validation/**
  - packages/core/extract.json
updated: 2026-11-01T17:10Z
---
# My Journey dashboard port — `AUTOPILOT.MY_JOURNEY /autopilot` (guided mode, teacher catalog, autopilot popup)
Plan: `.kiro/specs/native-wave2-journey-autopilot-r2/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: journey -->` (tasks 1–9) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start
before `vtid:` is set here.
**Measured on the worktree (= origin/main):** 1 ledger row under `"lane": "journey-autopilot"` for this lane,
`not_started` — `AUTOPILOT.MY_JOURNEY /autopilot` (`kind: screen`, `source: registry`). Web source
`src/pages/AutopilotDashboard.tsx` (605 lines; route `src/App.tsx:1538-1543`). Components reused / twinned:
`components/journey/GuidedModeSwitch.tsx` (39; VTID-03279), `GuidedJourneyCatalog.tsx` (691; VTID-03280, the teacher /
guided-topic catalog), `JourneyHowItWorks.tsx`, `GoalNorthStar.tsx` / `DreamNorthStar.tsx`, the preview tiles
(`TodaysGoalCard`, `FutureSelfTiles`, `MatchesPreview`, `EventsPreview`, `AutopilotCard`), the goal sheets
(`GoalSetupDialog`, `GoalPlanSheet`), the autopilot popup `components/AutopilotPopup.tsx` (717); providers
re-implemented natively (class-B): `context/GuidedModeProvider.tsx` (221), `hooks/use-autopilot.ts` (594,
runtime-imports `@/integrations/supabase/client:4`), `hooks/useGuidedJourneyProgress.ts` (362). Pure helpers extracted
to `@vitana/core`: `lib/horizonBuckets.ts` (122), `lib/vitana-projection.ts` (122) — both IO-free.
**Goal.** Port the My Journey dashboard to native on the N3 shell at 1:1 mobile-web parity (`dashboard` Spotlight
archetype): the Spotlight `JourneyHero` + goal/dream north-star as the single `spotlight` `VCard`, the Vitana Index
trajectory card, the guided-mode switch (backed by a native re-implementation of `GuidedModeProvider`), the
guided-journey / teacher catalog, "how it works", the today's-goal / future-self / matches / events / autopilot
preview tiles, the autopilot recommendations popup (native bottom sheet backed by a native `use-autopilot`), and the
goal setup / plan sheets (goal-plan generation carries the user locale). **This lane owns the core extraction** of the
two pure helpers (task 1) rather than re-implementing them. Flips the 1 parity row to `native`.
**Acceptance (the reviewer seat checks these):**
- Requirements R1–R6 for the My Journey surface; mobile-web parity; `@vitana/core`-only web bridge; every hook /
  provider re-implemented natively (no class-B module extracted); the two pure helpers re-exported through core.
- `npm run typecheck`, `npm test` (dashboard loaded/empty/error; sections render; guided-mode toggle; catalog
  topic/teacher rows; autopilot popup open + snooze/dismiss persistence; goal-plan sheet; pure helpers via core),
  `APP_PROFILE=development npm run bundle`, `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (from
  `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/core-closure.mjs --check` and `node scripts/native/parity-ledger.mjs --check` green with the 1
  row `native` and its route `apps/mobile/app/(app)/autopilot/index.tsx` present.
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form) in `src/i18n/*/journeyAutopilotNative.json`
  then mirrored; RTL (`ar`) covered; no hardcoded user-visible text; no physical `left`/`right`. AI-content locale
  injected on the goal-plan / guided-journey LLM calls.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (this lane's read-only spec) and `plan-sparring.md`.
- **Device-runtime parity (task 8)** is deferred to G1 as `next_actor: owner`; not a merge blocker, recorded in this
  log and `staging-tests.json`.
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 1 row), `packages/core/manifest.json`
+ closure + `src/**` + `scripts/native/mobile-ci-paths.generated.json` (only this lane's re-exports — the two pure
helpers), and the DE-first i18n shard are shared by row/line; resolve a merge conflict by keeping both lanes'
rows/keys. `apps/mobile/src/ports/**` and `apps/mobile/src/navigation/resolve.ts` are shared native-infra read
surfaces listed so the Lane-scope check does not fail; this lane does not restructure them.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only; the native app has no production profile.
## Log
### 2026-11-01T17:10Z · kiro-exafyltd-202611011658-9f52 · ready
Lane created with the plan (re-plan of `native-wave2-journey-autopilot/journey`, PR #4270); `paths` widened to the shared native-infra files.
