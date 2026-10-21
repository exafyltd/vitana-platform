---
slug: native-wave2-health-biology
author: kiro
executor: kiro
next_actor: kiro
state: drafted
author_seat: exafyltd
updated: 2026-10-15T19:13Z
spar_refs:
  - exafyltd/vitana-v1: main
---
# Handoff — Native Wave 2: Health / Vitana Index / Biology screen ports (+ in-screen Health Sync UI)
Wave 2 screen-port batch of the native Maxina app program (vitana-v1 `docs/programs/native-app/NATIVE-APP-PLAN.md`,
program VTID-05021; Wave 2 lane list in §5). Picks up the "health/Vitana Index/biology + Health Sync UI" item in
`vitana-platform:.kiro/specs/health-native/handoff.md` "What Kiro does next" → Wave 2 screen ports. Plan block:
`plan.md`. Lanes: `lanes/*.md` (3, all `ready`, executor kiro, seat exafyltd → reviewer_seat hotmail, disjoint
`paths`, no `vtid` yet). Ports the 24 web destinations the parity ledger assigns to `"lane": "health"` to native at
1:1 mobile-web parity on `@vitana/core` + `@vitana/ui` + the N3 shell; fixture / fake-gateway tests only, device-runtime
parity deferred to G1 (`next_actor: owner`). No web screen, `App.tsx` route or registry/manifest change — only native
route files and parity-row status flips.

**Collab session (planning):** `kiro-202610151913-51bd`.

**This is plan-authoring only.** No VTID is allocated here, no product/native code is written, nothing is merged,
pushed to prod or written to any live system. A later step handles the branch, commit, push and PR. Sparring follows
the standing process: the `plan(native-wave2-health-biology)` PR is sparred by CI (`PLAN-SPAR.yml`); on convergence it
is approved by policy (`converged-auto-v1`) and CI writes the VTIDs into the lanes. No `docs/validation/<VTID>/`
directory is created here — the lanes' `paths` reference `docs/validation/**` for the future executor only.

## Health Hub coordination (boundary with the `health-native` spec)
Health data is governed by the Health Hub program (`docs/programs/health-hub/HEALTH-HUB-PLAN.md`, VTID-05020). The
in-flight `health-native` spec's lane **`n5a-health-sync` (VTID-05184)** owns the native **Health Sync module**
(HealthKit + Health Connect integration, OS permission strings, ingest contract), switched off until its
C1/D10/DPIA/0T preconditions. **This cluster owns only the health SCREENS** and the **in-screen** "connect Apple
Health / Health Connect / device" affordance, which delegates to that module's public read-only-until-enabled entry
(or a typed stub behind the ingest-off flag if the module is not yet on main, logged as a dependency). The standalone
Connected Apps settings screen (`/settings/connected-apps`) and `/connectors?tab=health` are **not** here — the ledger
assigns them to `"lane": "profile-settings-support"`. Every health-data read uses the same RLS-scoped
(`user_id = auth.uid()`) path as web, respects the member's existing consent, inherits the §2 wellness boundary, and
**writes nothing to production** (reads only; no production profile; fixture tests only). See `plan.md` "Health Hub
coordination" for the full boundary.

## Log
### 2026-10-15T19:13Z · kiro-202610151913-51bd · created → drafted
Planner (plan-authoring step; not holding a `_plan` claim — this is the authoring pass, the claim/branch/PR is a later
step). Measured on the worktree (= origin/main): `apps/mobile/parity/ledger.json` version 2 has **24 rows with
`"lane": "health"`, every one `not_started`** (23 screen, 1 overlay; 435 rows total), counted with `node -e` over the
committed ledger (the `--report` CLI needs `typescript`, not installed here). Verified the 8 web source pages
(`Health.tsx`, `health/VitanaIndexDetail.tsx`, `health/MyBiology.tsx`, `health/PillarsOfHealth.tsx`,
`health/ConditionsRisks.tsx`, `health/EducationResources.tsx`, `health/Plans.tsx`, `health/WellnessServices.tsx`) + the
Vitana Index overlay (`components/health/VitanaIndexSheet.tsx`) + the mobile health widgets/chips exist, and the
`App.tsx` route lines (`src/App.tsx:1126-1168`). Confirmed the health-data hooks (`useVitanaIndex`,
`useVitanaIndexHistory`, `useUserSupplements`, `useProfileHealthSummary`) runtime-import
`@/integrations/supabase/client.ts` → class B → not movable to core (decision 2). Confirmed the Connected Apps /
connectors-health screens are in `"lane": "profile-settings-support"`, not here, so the Health Sync boundary is clean.
Wrote `plan.md`, `handoff.md`, `tasks.md` and 3 lane files; partitioned the 24 rows into `health-hub` (4),
`vitana-index-biology` (4), `health-plans-services` (16) with disjoint native file subtrees and ledger-rows-by-row —
0 overlap, 0 orphan. No VTID allocated, no product/native code changed, no live system touched.

Next: a later step opens the `plan(native-wave2-health-biology)` PR; PLAN-SPAR spars it and this plan answers each
round in `sparring/responses-<n>.md`. On convergence CI writes the VTIDs into the lanes; then seat `exafyltd` claims
lanes in dependency order — `health-hub` and `health-plans-services` in parallel, `vitana-index-biology` after
`health-hub` is `done` (it consumes the native Vitana Index data module + chip twins that `health-hub` owns). Reviewer
seat `hotmail` reviews each lane. Device-runtime parity (the last task in each lane) waits on the owner's G1 isolated
test environment.
