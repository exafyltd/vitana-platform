# Tasks — Native Wave 2: Health / Vitana Index / Biology screen ports (+ in-screen Health Sync UI)
Three lanes, disjoint `paths`. Plan: `plan.md` (plan block) and this file are authoritative — follow them exactly;
anything outside them is a plan change (log it, set `next_actor: claude`). VTIDs are assigned by CI after PLAN-SPAR
converges; do not start a lane before its `vtid:` is set in `lanes/<id>.md`. All commands run from `apps/mobile/`
unless noted; `assertNotProduction()` and the no-production-profile rule make every command offline. **Health-data
reads respect consent; nothing is written to a live system; the in-screen Health Sync affordance delegates to the
`n5a-health-sync` module and never requests an OS permission or ingests on its own** (see `plan.md` "Health Hub
coordination").

<!-- lane: health-hub -->
## Lane `health-hub` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports: `HEALTH.OVERVIEW /health`, `HEALTH.MEDICAL /health?mode=medical`, `HEALTH.SUPPLEMENTS /health?mode=supplements`,
`OVERLAY.VITANA_INDEX /health` (4 ledger rows under `"lane": "health"`). depends_on: none. Web source
`src/pages/Health.tsx` (mobile branch: the `MobileModePill` overview/medical/supplements tabs,
`MobileHealthSnapshot`/`MobilePriorityFocus`/`MobileAutopilotGuidance`, `MobileHealthMedicalTab`/
`MobileHealthSupplementsTab`, `HealthReportUploadSheet`/`QuickLabOrderSheet`), overlay
`src/components/health/VitanaIndexSheet.tsx` + `VitanaIndexProvider.tsx`, chips
`src/components/mobile/MobileActionChips.tsx`. **This lane owns the core extraction, the native health-data fetch +
consent gate, the Vitana Index chip twins, and the in-screen Health Sync affordance.**
- [ ] 1. Core extraction — pure helpers only: add manifest + re-export entries in `packages/core/src/**` for the
  IO-free Vitana Index math (`src/lib/vitanaIndex.ts` — `getVitanaIndexTier`, and the pure `pillarKeys`/`pillarLabel`
  exports from `src/hooks/useVitanaIndex.ts` **only if** they carry no runtime import to a class-B module; if a helper
  is entangled with the supabase-client hook, lift the pure part into a new `src/lib/*` module first) and any pure
  biology-report formatting helper the biology lane will also need. The health-data **hooks** are NOT added to core
  (they runtime-import `@/integrations/supabase/client.ts`). Then `node scripts/native/core-closure.mjs --write` and
  commit the regenerated generated files in this PR.
  Files: `packages/core/manifest.json`, `packages/core/src/**`, `packages/core/closure.generated.json`,
  `scripts/native/mobile-ci-paths.generated.json`.
  Verify (repo root): `node scripts/native/core-closure.mjs --check` passes; `apps/mobile` → `npm run typecheck` green.
- [ ] 2. Native health-data module (consumed by this lane and `vitana-index-biology` via a port): a native
  `apps/mobile/src/screens/health/data/**` that re-implements the Vitana Index read (web `useVitanaIndex`/
  `useVitanaIndexHistory`), the profile health summary and the supplements read using the **native Supabase client +
  native auth context** (shell auth from N3), RLS-scoped `user_id = auth.uid()` exactly as web — reads only, consent
  respected, no non-GET, no OS permission. Expose it through a port so the biology lane reuses it.
  Files: `apps/mobile/src/screens/health/data/**`, `apps/mobile/src/ports/**` (a health-data port entry only).
  Verify: `npm test` (the consent/no-write unit test below) + `npm run typecheck` green.
- [ ] 3. Native Health dashboard on the N3 shell: `apps/mobile/app/(app)/health/index.tsx` +
  `apps/mobile/src/screens/health/HealthScreen.tsx` render the mobile-web branch of `Health.tsx` — the
  `MobileModePill` with overview / medical / supplements driven by the `mode` search param
  (`HEALTH.MEDICAL`/`HEALTH.SUPPLEMENTS` are `?mode=` states, honour `normalizeHealthMode`), the
  `MobileHealthSnapshot` (taps open the Vitana Index overlay), `MobilePriorityFocus`, `MobileAutopilotGuidance`,
  `MobileHealthMedicalTab`, `MobileHealthSupplementsTab`, and the header `VitanaIndexChip`/`AutopilotChip` twins. Build
  native twins of those widgets/chips under `src/screens/health/**`. The upload / lab-order sheets are presented but
  their writes are stubbed/disabled (no production write).
  Files: `apps/mobile/app/(app)/health/index.tsx`, `apps/mobile/src/screens/health/**`.
  Verify: `npm test` (dashboard + mode-tab tests) + `npm run typecheck` green.
- [ ] 4. Vitana Index overlay (`OVERLAY.VITANA_INDEX /health`): native twin of `VitanaIndexSheet.tsx` opened from the
  snapshot/chip (the web `VITANA_INDEX_OPEN_EVENT` becomes a native open handler), rendering the consented Index data
  from the task-2 module. Mobile-web branch only.
  Files: `apps/mobile/src/screens/health/VitanaIndexSheet.tsx`, `apps/mobile/src/screens/health/**`.
  Verify: `npm test` (overlay open/dismiss, data render) + `npm run typecheck` green.
- [ ] 5. In-screen Health Sync affordance: the "Connect Apple Health / Health Connect / device" entry points that web
  renders inside the health screens call the `n5a-health-sync` module's public read-only-until-enabled entry (a
  `@vitana/core` or `apps/mobile/src/health-sync` export the module owns). If that entry is not yet on main, render the
  affordance against a typed stub behind the same ingest-off flag and log the dependency (`next_actor: kiro`). The
  affordance never requests an OS permission or ingests here — that is N5a's module.
  Files: `apps/mobile/src/screens/health/**` (affordance component only; it imports the module, it does not implement
  it).
  Verify: `npm test` — the affordance resolves to the module entry / stub; no OS-permission or ingest call is made.
- [ ] 6. i18n + RTL: user-visible strings from the web shards (`screens.health.*`); any genuinely new key added to
  `src/i18n/de/*.json` first, then the other ten (ar de en es fr pl pt ru sr tr zh); render under `ar` with start/end
  only; no hardcoded text, no physical `left`/`right`. Do **not** add `screens.nativeHealthSync.osPermission.*` keys —
  those are N5a's.
  Files: `src/i18n/*/healthNative.json` (DE first), `apps/mobile/src/screens/health/**`.
  Verify: `npm run typecheck`; `npm test` — the no-raw-text and no-physical-direction tests pass.
- [ ] 7. Unit tests (fake gateway / fixtures, no network): dashboard loaded/empty/error; overview/medical/supplements
  mode-tab switch; snapshot/priority/guidance widgets; Vitana Index overlay open/dismiss + data render; the Health Sync
  affordance resolves to the module entry behind the ingest-off flag; **consent/no-write test** — reads are RLS-scoped
  `user_id = auth.uid()`, no non-GET to gateway/Supabase, no OS-permission/ingest from the affordance. React 19 —
  `ReactElement`, no global `JSX`.
  Files: `apps/mobile/src/screens/health/__tests__/**`, `apps/mobile/app/(app)/health/__tests__/**`.
  Verify: `npm test` green; `APP_PROFILE=development npm run bundle` and
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 8. Flip the lane's parity rows to `native` and verify: `node scripts/native/parity-ledger.mjs --sync` (status
  edited by hand to `native` for the 4 rows), then `--check`.
  Files: `apps/mobile/parity/ledger.json` (health-hub rows only), `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 9. **(depends-on-owner / G1 — `next_actor: owner`)** Device-runtime parity: Maestro journey(s)
  `apps/mobile/maestro/health/*.yaml`, iOS simulator + Android emulator screenshots at the device sizes, screenshot
  parity vs the 390×844 read-only staging web `/health`. Blocked until G1 (and macOS minutes / G3 for iOS on a device).
  Files: `apps/mobile/maestro/health/**`, `docs/validation/<VTID>/staging-tests.json`.
  Verify: on G1 only; recorded in the lane log, not run in CI.
- [ ] 10. PR: branch `kiro/native-wave2-health-biology-r2/health-hub`, title
  `VTID-xxxxx (native-wave2-health-biology-r2/health-hub): native Health dashboard + Vitana Index overlay port`, body
  names the Kiro session id, Summary / Decisions taken / Tests / Handoff. Commit trailers `Collab-Session: <kiro id>`,
  `Collab-Lane: native-wave2-health-biology-r2/health-hub`. Lane → `in-review`, `next_actor: kiro` (reviewer seat
  `hotmail`). Never merge, deploy or write to a live system (protocol §7a).

<!-- lane: vitana-index-biology -->
## Lane `vitana-index-biology` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports: `HEALTH.VITANA_INDEX /health/vitana-index`, `HEALTH.MY_BIOLOGY /health/my-biology`,
`HEALTH.BIOLOGY_OMICS /health/my-biology?tab=omics`, `HEALTH.BIOLOGY_SUPPLEMENTS /health/my-biology?tab=supplements`
(4 ledger rows). depends_on: `health-hub` (consumes the native Vitana Index data module + the chip twins that
`health-hub` owns). Web sources `src/pages/health/VitanaIndexDetail.tsx` (726 lines, route `src/App.tsx:1162`),
`src/pages/health/MyBiology.tsx` (medical/omics/supplements tabs, reads `lab_reports` + supplements, route
`src/App.tsx:1152`).
- [ ] 1. Vitana Index detail `apps/mobile/app/(app)/health/vitana-index.tsx` +
  `apps/mobile/src/screens/health/VitanaIndexDetailScreen.tsx`: native twin of `VitanaIndexDetail.tsx` on the N3 shell
  — pillar breakdown, trajectory, log-data dialog (`VitanaLogDataDialog`), pillar agents panel — consuming the
  consented Index data from `health-hub`'s native data module (port), not a new fetch. Mobile-web branch only.
  Files: `apps/mobile/app/(app)/health/vitana-index.tsx`, `apps/mobile/src/screens/health/VitanaIndexDetailScreen.tsx`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 2. Biology `apps/mobile/app/(app)/health/my-biology.tsx` +
  `apps/mobile/src/screens/health/MyBiologyScreen.tsx`: native twin of `MyBiology.tsx` with the medical / omics /
  supplements tabs via the `tab` search param (`HEALTH.BIOLOGY_OMICS`/`HEALTH.BIOLOGY_SUPPLEMENTS` are `?tab=` states),
  the lab-report lists (RLS-scoped read of `lab_reports` via the native data module / native Supabase client),
  supplement cards, and the upload/add-supplement affordances presented but write-disabled (no production write).
  Files: `apps/mobile/app/(app)/health/my-biology.tsx`, `apps/mobile/src/screens/health/MyBiologyScreen.tsx`,
  `apps/mobile/src/screens/health/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 3. i18n + RTL (as health-hub task 6) for the index detail + biology screens; new keys DE-first then the other
  ten.
  Files: `src/i18n/*/healthNative.json` (DE first), `apps/mobile/src/screens/health/**`.
  Verify: `npm run typecheck`; `npm test` no-raw-text / no-physical-direction tests pass.
- [ ] 4. Unit tests (fake gateway / fixtures, no network): index detail pillar breakdown + log-data dialog; biology
  medical/omics/supplements tab switch with loaded/empty/error; lab-report read is RLS-scoped and no non-GET is issued;
  supplement list loaded/empty. React 19 `ReactElement`.
  Files: `apps/mobile/src/screens/health/__tests__/**`, `apps/mobile/app/(app)/health/__tests__/**`.
  Verify: `npm test`; `APP_PROFILE=development npm run bundle`;
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 5. Flip the lane's 4 parity rows to `native`; `--sync` then `--check`.
  Files: `apps/mobile/parity/ledger.json` (vitana-index-biology rows only),
  `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 6. **(depends-on-owner / G1 — `next_actor: owner`)** Maestro `apps/mobile/maestro/health/*.yaml` (index +
  biology journeys) + sim/emulator screenshots + parity vs 390×844 staging `/health/vitana-index` and
  `/health/my-biology`. Blocked until G1 (+ macOS/G3 for iOS).
  Files: `apps/mobile/maestro/health/**`, `docs/validation/<VTID>/staging-tests.json`.
- [ ] 7. PR: branch `kiro/native-wave2-health-biology-r2/vitana-index-biology`, title
  `VTID-xxxxx (native-wave2-health-biology-r2/vitana-index-biology): native Vitana Index detail + biology port`; trailers
  `Collab-Session`, `Collab-Lane: native-wave2-health-biology-r2/vitana-index-biology`; lane → `in-review`,
  `next_actor: kiro`. No merge/deploy/live write.

<!-- lane: health-plans-services -->
## Lane `health-plans-services` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports (16 ledger rows): `HEALTH.PILLARS /health/pillars`, `HEALTH.CONDITIONS /health/conditions`,
`HEALTH.EDUCATION /health/education` (+ `?tab=podcasts` `HEALTH.EDUCATION_PODCASTS`, `?tab=videos`
`HEALTH.EDUCATION_VIDEOS`), `HEALTH.PLANS /health/plans` (+ `?tab=exercise` `HEALTH.PLANS_EXERCISE`, `?tab=hydration`
`HEALTH.PLANS_HYDRATION`, `?tab=mental` `HEALTH.PLANS_MENTAL`, `?tab=nutrition` `HEALTH.PLANS_NUTRITION`, `?tab=sleep`
`HEALTH.PLANS_SLEEP`), `HEALTH.SERVICES_HUB /health/services-hub` (+ `?tab=insuranceSupport` `HEALTH.SERVICES_INSURANCE`,
`?tab=medicalServices` `HEALTH.SERVICES_MEDICAL`, `?tab=myServices` `HEALTH.SERVICES_MINE`, `?tab=wellnessPrograms`
`HEALTH.SERVICES_WELLNESS`). depends_on: none — these screens are static/navigational and read no health data, so they
do not depend on `health-hub`'s data module. Web sources `src/pages/health/PillarsOfHealth.tsx` (109),
`ConditionsRisks.tsx` (84), `EducationResources.tsx` (234), `Plans.tsx` (383), `WellnessServices.tsx` (286); routes
`src/App.tsx:1132-1160`.
- [ ] 1. Pillars + Conditions: `apps/mobile/app/(app)/health/pillars.tsx` +
  `apps/mobile/src/screens/health/PillarsOfHealthScreen.tsx`, `apps/mobile/app/(app)/health/conditions.tsx` +
  `apps/mobile/src/screens/health/ConditionsRisksScreen.tsx`. Mobile-web twins of `PillarsOfHealth.tsx` /
  `ConditionsRisks.tsx` on the N3 shell (navigational card grids; no health-data read).
  Files: `apps/mobile/app/(app)/health/pillars.tsx`, `apps/mobile/app/(app)/health/conditions.tsx`,
  `apps/mobile/src/screens/health/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 2. Education (`apps/mobile/app/(app)/health/education.tsx` +
  `apps/mobile/src/screens/health/EducationResourcesScreen.tsx`) with the resources / podcasts / videos tabs via the
  `tab` search param (`HEALTH.EDUCATION_PODCASTS`/`HEALTH.EDUCATION_VIDEOS`). Twin of `EducationResources.tsx`.
  Files: `apps/mobile/app/(app)/health/education.tsx`, `apps/mobile/src/screens/health/EducationResourcesScreen.tsx`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 3. Plans (`apps/mobile/app/(app)/health/plans.tsx` + `apps/mobile/src/screens/health/PlansScreen.tsx`) with the
  exercise / hydration / mental / nutrition / sleep tabs via `?tab=` (the five `HEALTH.PLANS_*` rows). Twin of
  `Plans.tsx`.
  Files: `apps/mobile/app/(app)/health/plans.tsx`, `apps/mobile/src/screens/health/PlansScreen.tsx`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 4. Services Hub (`apps/mobile/app/(app)/health/services-hub.tsx` +
  `apps/mobile/src/screens/health/WellnessServicesScreen.tsx`) with the medical / wellness / insurance / my-services
  tabs via `?tab=` (the four `HEALTH.SERVICES_*` rows). Twin of `WellnessServices.tsx`.
  Files: `apps/mobile/app/(app)/health/services-hub.tsx`,
  `apps/mobile/src/screens/health/WellnessServicesScreen.tsx`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 5. i18n + RTL (as health-hub task 6) across all plans/services/pillars/conditions/education screens; new keys
  DE-first then the other ten.
  Files: `src/i18n/*/healthNative.json` (DE first), `apps/mobile/src/screens/health/**`.
  Verify: `npm run typecheck`; `npm test` no-raw-text / no-physical-direction tests pass.
- [ ] 6. Unit tests (fake gateway / fixtures) per screen type: each screen loaded; tab switch for education / plans /
  services; navigational card taps resolve to the right route. React 19 `ReactElement`.
  Files: `apps/mobile/src/screens/health/__tests__/**`, `apps/mobile/app/(app)/health/__tests__/**`.
  Verify: `npm test`; `APP_PROFILE=development npm run bundle`;
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 7. Flip the 16 parity rows to `native`; `--sync` then `--check`.
  Files: `apps/mobile/parity/ledger.json` (health-plans-services rows only),
  `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 8. **(depends-on-owner / G1 — `next_actor: owner`)** Maestro `apps/mobile/maestro/health/*.yaml`
  (plans/services/pillars/conditions/education journeys) + sim/emulator screenshots + parity vs the 390×844 read-only
  staging screens. Blocked until G1 (+ macOS/G3 for iOS).
  Files: `apps/mobile/maestro/health/**`, `docs/validation/<VTID>/staging-tests.json`.
- [ ] 9. PR: branch `kiro/native-wave2-health-biology-r2/health-plans-services`, title
  `VTID-xxxxx (native-wave2-health-biology-r2/health-plans-services): native pillars / conditions / education / plans / services port`;
  trailers `Collab-Session`, `Collab-Lane: native-wave2-health-biology-r2/health-plans-services`; lane → `in-review`,
  `next_actor: kiro`. No merge/deploy/live write.

## Acceptance (every lane; the reviewer seat checks these)
- The lane's screens meet 1:1 mobile-web parity; N2/N3 composition; `@vitana/core`-only web bridge; health-data reads
  are RLS-scoped and consent-respecting; the in-screen Health Sync affordance delegates to the `n5a-health-sync`
  module (no OS permission / ingest in this cluster).
- `npm run typecheck`, `npm test`, `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green; `node scripts/native/parity-ledger.mjs --check`
  green with the lane's rows `native`; `node scripts/native/core-closure.mjs --check` green.
- 11 locales, DE-first new keys, RTL covered; no hardcoded user-visible text; no physical `left`/`right`; no
  `screens.nativeHealthSync.osPermission.*` key added here (that is N5a's).
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** and **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (read-only) and `plan-sparring.md`.
- Device-runtime parity (the last G1 task) is deferred to G1 as `next_actor: owner`; not a merge blocker for the port,
  recorded in the lane log and `staging-tests.json`.
- Never: VTID allocation, merge/approve, workflow dispatch, deploy, Supabase/AWS writes, or any test against
  production (protocol §7a; program §6).
