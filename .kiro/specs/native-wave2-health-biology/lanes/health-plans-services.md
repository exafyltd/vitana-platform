---
lane: health-plans-services
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(app)/health/**
  - apps/mobile/src/screens/health/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/maestro/health/**
  - apps/mobile/tests/health/**
  - apps/mobile/parity/ledger.json
  - src/i18n/*/healthNative.json
  - docs/validation/**
updated: 2026-10-15T19:13Z
vtid:
---
# Pillars / conditions / education / plans / services-hub port
Plan: `.kiro/specs/native-wave2-health-biology/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: health-plans-services -->` (tasks 1–9) are authoritative. VTID: assigned by CI after PLAN-SPAR converges;
do not start before `vtid:` is set here.
**Measured on the worktree (= origin/main):** 16 ledger rows under `"lane": "health"` for this lane, all
`not_started` — `HEALTH.PILLARS /health/pillars`, `HEALTH.CONDITIONS /health/conditions`,
`HEALTH.EDUCATION /health/education` (+ `?tab=podcasts` `HEALTH.EDUCATION_PODCASTS`, `?tab=videos`
`HEALTH.EDUCATION_VIDEOS`), `HEALTH.PLANS /health/plans` (+ `?tab=exercise/hydration/mental/nutrition/sleep` —
`HEALTH.PLANS_EXERCISE`, `HEALTH.PLANS_HYDRATION`, `HEALTH.PLANS_MENTAL`, `HEALTH.PLANS_NUTRITION`,
`HEALTH.PLANS_SLEEP`), `HEALTH.SERVICES_HUB /health/services-hub` (+ `?tab=insuranceSupport/medicalServices/myServices/
wellnessPrograms` — `HEALTH.SERVICES_INSURANCE`, `HEALTH.SERVICES_MEDICAL`, `HEALTH.SERVICES_MINE`,
`HEALTH.SERVICES_WELLNESS`). Web sources `src/pages/health/PillarsOfHealth.tsx` (109), `ConditionsRisks.tsx` (84),
`EducationResources.tsx` (234), `Plans.tsx` (383), `WellnessServices.tsx` (286); routes `src/App.tsx:1132-1160`.
**Goal.** Port pillars, conditions, education (resources/podcasts/videos tabs), plans (five pillar tabs) and services
hub (four service tabs) to native on the N3 shell at 1:1 mobile-web parity — the `?tab=` states are the tab rows above.
These screens are static/navigational and read no health data, so this lane has **no dependency** on `health-hub`'s
data module and runs in parallel. Flips the 16 parity rows to `native`.
**Health Hub boundary (read `plan.md` "Health Hub coordination").** These screens render no member health data (they
are navigational hubs / static content), so there is no consent read to make here; still, no write to any live system,
no OS permission, no ingest. Nothing is written to production.
**Acceptance (the reviewer seat checks these):**
- 1:1 mobile-web parity for pillars, conditions, education (+2 tabs), plans (+5 tabs), services hub (+4 tabs);
  `@vitana/core`-only web bridge; tab states resolved via the `tab` search param.
- `npm run typecheck`, `npm test` (each screen loaded; education/plans/services tab switch; navigational card taps
  resolve to the right route), `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (all from `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/parity-ledger.mjs --check` green with the 16 rows `native` and their routes present in
  `apps/mobile/app/`. (This lane adds no core re-export, so it does not run `core-closure --write`; `--check` must
  still pass unchanged.)
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form) then mirrored; RTL (`ar`) covered; no
  hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (read-only) and `plan-sparring.md`.
- **Device-runtime parity (task 8)** is deferred to G1 as `next_actor: owner`; not a merge blocker, recorded in this
  log and `staging-tests.json`.
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 16 rows), `apps/mobile/src/ports/**` +
`resolve.ts`, and the DE-first i18n shard are shared by row/line with the other two lanes; resolve a merge conflict by
keeping both lanes' rows/keys. This lane shares the `apps/mobile/src/screens/health/**` subtree — own only the
`PillarsOfHealthScreen.tsx` / `ConditionsRisksScreen.tsx` / `EducationResourcesScreen.tsx` / `PlansScreen.tsx` /
`WellnessServicesScreen.tsx` files and their own `__tests__`, never the dashboard / overlay / index / biology /
data-module files the other two lanes own. This lane does **not** touch `packages/core/**` or
`scripts/native/mobile-ci-paths.generated.json` (no core extraction), so those globs are deliberately absent from its
`paths`.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only; the native app has no production profile;
class-B modules are NEVER moved into core.
## Log
### 2026-10-15T19:13Z · kiro-202610151913-51bd · created → ready
Lane drafted with the plan (`state: drafted` in `handoff.md`). The 16 rows and the paths were computed from the parity
ledger and `src/App.tsx` so no file belongs to two lanes. No deps — runs in parallel with `health-hub`. Next:
PLAN-SPAR spars the plan; once a VTID is written here, seat `exafyltd` claims the lane
(`queue.mjs claim native-wave2-health-biology/health-plans-services --session <id>`).
