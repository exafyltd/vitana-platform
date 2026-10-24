# Plan — native-wave2-health-biology
Author: Kiro, seat `exafyltd`. Repo: `exafyltd/vitana-v1` (native app only — `apps/mobile/**`, `packages/core/**`
via the manifest/closure process, `apps/mobile/parity/ledger.json`, DE-first i18n shards, `docs/validation/**`; no
backend, no gateway change, no migration). Spec: `handoff.md`, `tasks.md`, `lanes/*.md` in this folder. Programs:
vitana-v1 `docs/programs/native-app/NATIVE-APP-PLAN.md` (VTID-05021) §5 Wave 2, and
`docs/programs/health-hub/HEALTH-HUB-PLAN.md` (VTID-05020) for the health-data consent boundary.
<!-- plan:begin -->
## Cross-repo sparring
This plan's implementation lives in `exafyltd/vitana-v1` (native app `apps/mobile/**`, `packages/core/**`, the parity
ledger, i18n shards), while the plan PR itself is in `exafyltd/vitana-platform`. Every load-bearing premise the
sparring partner must verify — the IO-freedom of `src/lib/vitanaIndex.ts`, the 4+4+16=24 parity-ledger partition for
`"lane": "health"`, the no-health-data claim for `Plans.tsx`/`WellnessServices.tsx`, and the N5a export signature on
`vitana-v1` main — is a vitana-v1 file, read through the `spar_refs` (`exafyltd/vitana-v1: main`) declared in
`handoff.md`. The `main` ref is valid: `resolveRef` (`scripts/collab/plan-spar.mjs:80-83`) resolves any non-SHA ref
via the GitHub commits API to a concrete SHA at `client.create` time; the SHA-only restriction in the older
`plan-spar-vitana-v1-ref` design note was superseded by that shipped implementation.

## Sparring status
Rounds 1–2 ran blind: `spar_refs` is applied only at `client.create`, never at `client.round`
(`scripts/collab/plan-spar.mjs:333`), so the in-progress round-1 session never acquired vitana-v1 read access
(`responses-2.md`, finding R1-F1). A fresh session is required so the partner can verify the frontend premises; this
plan-text change (plus the R1-F5 fix) sets up the `replan` path (a changed plan on an escalated, non-infra session
creates a new session with `spar_refs` applied).
## Goal
Wave 2 screen-port batch of the native Maxina app: port the **health / Vitana Index / biology** cluster — the 24 web
destinations the parity ledger assigns to `"lane": "health"` — plus the **in-screen Health Sync UI** (the
"connect Apple Health / Health Connect / device" affordances that live inside the health screens) to the native app
(`apps/mobile/`) at 1:1 parity with today's **mobile web** screens (the `useIsMobile()` ≤ 1024 px branch), built on
`@vitana/core` + `@vitana/tokens` + the N2 UI kit (`@vitana/ui`) on the Wave 1 N3 shell, with fixture / fake-gateway
unit tests. Does **not** need G1 planned or built to land the ports; every device-runtime verification step is marked
depends-on-owner (G1). No redesign (program §4), no new web screen, no `App.tsx` route, no registry/manifest change —
only native route files and parity-row status flips. **Health-data reads respect consent and nothing is written to a
live system.**

## Measured state (worktree = origin/main, parity ledger `apps/mobile/parity/ledger.json` version 2)
- **24 rows** carry `"lane": "health"`, **all `status: "not_started"`** (23 `screen`, 1 `overlay`); **435 rows total**.
  Counted with `node -e` over the committed ledger (the `--report` CLI needs `typescript`, not installed in this
  worktree). The 24 rows and their web paths are listed in the lane files and in `tasks.md`.
- Web sources verified present in `exafyltd/vitana-v1` with line counts: `src/pages/Health.tsx` (dashboard, mobile
  branch has the three mode tabs overview/medical/supplements), `src/pages/health/VitanaIndexDetail.tsx` (726),
  `src/pages/health/MyBiology.tsx` (medical / omics / supplements tabs, reads `lab_reports` + supplements),
  `src/pages/health/PillarsOfHealth.tsx` (109), `src/pages/health/ConditionsRisks.tsx` (84),
  `src/pages/health/EducationResources.tsx` (234), `src/pages/health/Plans.tsx` (383),
  `src/pages/health/WellnessServices.tsx` (286, the `/health/services-hub` screen); the Vitana Index **overlay**
  `src/components/health/VitanaIndexSheet.tsx` (496) + `VitanaIndexProvider.tsx` + the mobile chips
  `src/components/mobile/MobileActionChips.tsx` (`VitanaIndexChip`/`AutopilotChip`) and the mobile health widgets
  `src/components/health/mobile/{MobileHealthSnapshot,MobilePriorityFocus,MobileAutopilotGuidance,MobileHealthMedicalTab,MobileHealthSupplementsTab}.tsx`
  + the sheets `HealthReportUploadSheet.tsx` / `QuickLabOrderSheet.tsx`. Routes at `src/App.tsx:1126-1168`
  (`/health`, `/health/pillars`, `/health/services-hub`, `/health/conditions`, `/health/education`,
  `/health/my-biology`, `/health/plans`, `/health/vitana-index`). (Line counts are an **approximate** snapshot for
  scoping; exact counts are not load-bearing.)
- Wave 1 is on main: N3 shell + resolver route (`apps/mobile/app/(app)/[...path].tsx`, VTID-05186), N2 UI kit
  (`@vitana/ui`, VTID-05176), N1 `@vitana/core`/`@vitana/tokens` (VTID-05183). Prop map, ports and conventions in
  `apps/mobile/README.md`. The native app has no production profile; `assertNotProduction()` refuses prod/staging hosts.

## Health Hub coordination (CRITICAL — read `docs/programs/health-hub/HEALTH-HUB-PLAN.md` §2/§3 and the
`health-native` spec's `n5a-health-sync` lane before starting)
Health data is governed by the **Health Hub** program (VTID-05020). The boundary between THIS native-port cluster and
the in-flight **`health-native`** spec (`vitana-platform:.kiro/specs/health-native/`, lanes own `apps/mobile/**` +
`packages/core/**` + `packages/tokens/**` for the health-data plumbing) is:

- **This cluster owns the SCREENS** — the native React Native twins of the health dashboard, Vitana Index detail +
  overlay, biology, plans, services, conditions, education, under `apps/mobile/src/screens/health/**` and
  `apps/mobile/app/(app)/health/**`. It **renders** health data the member has already consented to; it never adds a
  new ingest path, a new OS permission, or a native HealthKit/Health Connect module.
- **`health-native` (lane `n5a-health-sync`, VTID-05184) owns the Health Sync MODULE** — the native HealthKit +
  Health Connect integration, the OS permission strings (`screens.nativeHealthSync.osPermission.*`, VTID-05185), the
  ingest contract types/schema/fixtures vendored from Health Hub Phase-1 C1, and the `apps/mobile/src/health-sync/**`
  (or equivalent) plumbing. It is **switched off** (ingest flag) until the C1/D10/DPIA/0T preconditions are met.
- **The "Health Sync UI" this cluster ports is only the in-SCREEN affordance** — the "Connect Apple Health",
  "Connect Health Connect", "Connect device", "Connect API" entry points and their consent-copy that already live
  inside `Health.tsx` / `MyBiology.tsx` on web. The native twin renders the SAME entry points and, when tapped, calls
  the `n5a-health-sync` module's **public, read-only-until-enabled** entry (a `@vitana/core` or
  `apps/mobile/src/health-sync` export the module owns) — it does **not** re-implement OS permission requests or
  ingest. If the module export is not yet on main when a lane needs it, the lane renders the affordance against a
  typed stub behind the same ingest-off flag and records the dependency in its log (`next_actor: kiro`), exactly as
  N5a itself stubbed N3/N4 before they landed. **The stub is a pinned interface with a contract test (R1-F5):** the
  `n5a-health-sync` **module code is already merged to vitana-v1 `main`** (#1398 → `8fea5e652`, 2026-10-14), but its
  ingest contract is owner-blocked on C1 (#4107) / D10 (the `d10-consents` migration) with no near-term timeline, and
  `n5a-health-sync.md:16-19` records that the remaining Kiro work is to **re-vendor the Health Sync contract from C1's
  merge commit** (not from the #1398 branch). So `health-hub` does not write an ad-hoc stub — it vendors the module's
  public read-only-until-enabled entry **signature** from the N5a export **as landed on `vitana-v1` main**
  (`8fea5e652`, verified against the live file in the fresh vitana-v1-pinned sparring session), encodes it as an
  explicit TypeScript `interface` the stub implements, and adds a **contract test** that imports both the stub and —
  through the real module path — the N5a export and asserts structural compatibility (a type-level assignability
  assertion plus a runtime shape check). The test compiles against the stub today and exercises the real export the
  moment the ingest flag can turn on; if the N5a entry changes shape in between, the contract test fails in NATIVE-CI
  rather than shipping a silently broken delegate call. The lane log records a `next_actor: kiro` task to
  **re-pin the vendored signature to C1's merge commit** once C1 lands and the contract is re-vendored, so the stub
  and the contract test track the final contract shape, not an interim one.
  The standalone **Connected Apps** settings screen
  (`SETTINGS.CONNECTED_APPS /settings/connected-apps`) and the `/connectors?tab=health` screen are **NOT** in this
  cluster — the parity ledger assigns them to `"lane": "profile-settings-support"`, a different Wave 2 batch.
- **Consent on reads.** Every health-data read (Vitana Index `vitana_index_scores`, `lab_reports`, supplements,
  `useProfileHealthSummary`) goes through the same RLS-scoped (`user_id = auth.uid()`) path the web uses, re-fetched
  natively via the native Supabase client + native auth context (these hooks runtime-import
  `@/integrations/supabase/client.ts`, a class-B module, so they are **not** moved to core — see decision 2). The
  native screens show only data the signed-in member can already see; no category the member has not consented to is
  requested or displayed, and the §2 wellness boundary (no disease labels, no alerts) is inherited unchanged from the
  web screens, not re-derived.
- **No health data is written to production.** Reads only; the native app has no production profile
  (`assertNotProduction()`); fixture / fake-gateway tests only; device-runtime verification deferred to G1. This is a
  hard rule in every lane file (program §6, collaboration §7a).

## Decisions (made by Kiro as planner under the owner's "finish the native apps" instruction; sparring may revise)
1. **Three disjoint lanes by sub-cluster.** `health-hub` (the dashboard + its mode tabs + the Vitana Index overlay +
   the health-data native fetch/consent module-consumer + the in-screen Health Sync affordance), `vitana-index-biology`
   (the Vitana Index detail page + the biology screens), `health-plans-services` (pillars, conditions, education,
   plans, services hub). The three touch disjoint route files and `src/screens` subtrees, build/review independently,
   each leaves the app buildable. **Partition against the ledger: `health-hub` 4 rows, `vitana-index-biology` 4 rows,
   `health-plans-services` 16 rows = 24** (see the table below), 0 overlap, 0 orphan.
2. **The health-data-fetching hooks do NOT move into `@vitana/core`; only pure helpers do.** `useVitanaIndex`,
   `useVitanaIndexHistory`, `useUserSupplements`, `useProfileHealthSummary` all runtime-import
   `@/integrations/supabase/client.ts` (a class-B module with `import.meta.env` / `localStorage` / the prod Supabase
   URL), so adding them to core would fail `core-closure.mjs --check` (`m.own !== 'A'`). Instead `health-hub`
   **re-implements the fetching natively** (native Supabase client + native auth context) and the biology/index lanes
   consume that native data module via a port. Only the **pure, IO-free** helpers the screens need — the Vitana Index
   tier/label/pillar math (`src/lib/vitanaIndex.ts`, `pillarKeys`/`pillarLabel`/`getVitanaIndexTier`), and any pure
   formatting the biology report cards use — move into core as re-export entries, and only if a check confirms they
   reach no class-B file. Type-only imports are excluded from the runtime graph by
   `scripts/native/extraction-deps.mjs` and resolve through the native `@/*` → `../../src/*` alias, so they get no
   core re-export.
3. **`health-hub` owns the core extraction and the native health-data module + consent gate + the Vitana Index chip
   twins + the in-screen Health Sync affordance**, so those have exactly one owner. Therefore
   **`vitana-index-biology` depends_on `health-hub`** (it consumes the native Vitana Index data module and the chip
   twins). `health-plans-services` has no dependency on either (its screens are static/navigational — pillars,
   conditions, education, plans, services hub — and read no health data) and runs in parallel.
4. **No new routes / registry / manifest.** Ports of screens already in `App.tsx` + `screens.json`; a native Expo
   Router file is not an `App.tsx` route, so the "new page needs screens.json/exclusions.json + screen-manifest +
   parity rows" rule does not fire — only parity-row **status** flips (`not_started`→`in_progress`→`native`).
5. **Device-runtime verification deferred to G1** (owner gate). Lanes land with offline build + fake-gateway unit
   tests green; the Maestro / simulator / screenshot-parity pass is a `next_actor: owner` task recorded in the lane and
   `staging-tests.json`. Matches the program's "fixture / fake-gateway tests only until G1" model.
6. **Mobile-web parity, not desktop.** Each native screen mirrors the `useIsMobile()` ≤ 1024 px branch of its source
   (e.g. `Health.tsx`'s `if (isMobile)` dashboard with the `MobileModePill` tabs, the `MobileHealthSnapshot` /
   `MobilePriorityFocus` / `MobileAutopilotGuidance` widgets, the medical/supplements mobile tabs), composed through
   N3/N2, every visual value from `@vitana/tokens`. The Spotlight desktop/Tier-B branches are not ported; no web file
   is touched beyond a DE-first i18n key and a `@vitana/core` re-export line.

## Lanes (all `ready`, executor kiro; seat → reviewer_seat; `vtid:` filled by CI on convergence)
| Lane | Seat → reviewer | Scope (web destinations) | depends_on |
|---|---|---|---|
| `health-hub` | exafyltd → hotmail | `/health` dashboard (`HEALTH.OVERVIEW`, `HEALTH.MEDICAL /health?mode=medical`, `HEALTH.SUPPLEMENTS /health?mode=supplements`) + the Vitana Index **overlay** (`OVERLAY.VITANA_INDEX /health`); the in-screen Health Sync affordance; **AND owns the core extraction** (pure Vitana Index math + biology-card helpers) + the native health-data fetch/consent module + the `VitanaIndexChip`/`AutopilotChip` twins (**4 parity rows**) | — |
| `vitana-index-biology` | exafyltd → hotmail | Vitana Index detail `HEALTH.VITANA_INDEX /health/vitana-index`; biology `HEALTH.MY_BIOLOGY /health/my-biology` (+ `?tab=omics` `HEALTH.BIOLOGY_OMICS`, `?tab=supplements` `HEALTH.BIOLOGY_SUPPLEMENTS`) (**4 parity rows**) | `health-hub` |
| `health-plans-services` | exafyltd → hotmail | pillars `HEALTH.PILLARS`, conditions `HEALTH.CONDITIONS`, education `HEALTH.EDUCATION` (+`?tab=podcasts` `HEALTH.EDUCATION_PODCASTS`, `?tab=videos` `HEALTH.EDUCATION_VIDEOS`), plans `HEALTH.PLANS` (+`?tab=exercise/hydration/mental/nutrition/sleep`), services hub `HEALTH.SERVICES_HUB` (+`?tab=insuranceSupport/medicalServices/myServices/wellnessPrograms`) (**16 parity rows**) | — |

Exact `paths` globs are in each `lanes/<id>.md`; the 24 parity rows partition **4 (health-hub) + 4
(vitana-index-biology) + 16 (health-plans-services)** with 0 overlap and 0 orphan. `health-hub` and
`health-plans-services` run in parallel; `vitana-index-biology` waits for `health-hub` (the native Vitana Index data
module + chip twins).

## Test plan
- **Per lane, offline (fixture / fake gateway, no network):** from `apps/mobile/` — `npm run typecheck`, `npm test`
  (jest-expo + RNTL: loaded/empty/error per screen; health-hub dashboard mode-tab switch overview/medical/supplements,
  Vitana Index overlay open/dismiss, snapshot/priority/guidance widgets, the Health Sync affordance tap resolving to
  the module entry behind the ingest-off flag; index detail pillar breakdown + log-data dialog; biology medical/omics/
  supplements tabs with loaded/empty/error; plans/services tab switches; i18n no-raw-text + RTL start/end; React 19
  `ReactElement`), `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check`. From the repo root —
  `node scripts/native/parity-ledger.mjs --check` (rows `native`, routes present).
- **Consent / no-write checks:** a unit test asserts the native health screens request/display only data the signed-in
  member already has RLS access to (the fetch uses the same `user_id = auth.uid()`-scoped query as web) and that no
  code path issues a non-GET to the gateway or Supabase (network guard), and that the in-screen Health Sync affordance
  does not itself request an OS permission or ingest (it delegates to the `n5a-health-sync` module).
- **Health Sync stub contract test (R1-F5):** a test asserts the `health-hub` typed stub is structurally compatible
  with the `n5a-health-sync` public read-only entry — a type-level assignability assertion against the vendored
  `interface` plus a runtime shape check — importing the real export through its module path so the check flips from
  stub to real export automatically when N5a lands on main, failing NATIVE-CI if the shapes diverge.
- **Core extraction deliverable: run `--write` AND commit the generated files, not just `--check`.** The lane that adds
  the pure-helper re-export entries to `packages/core/src/` (health-hub) MUST also run
  `node scripts/native/core-closure.mjs --write` and commit the regenerated `packages/core/closure.generated.json` and
  `scripts/native/mobile-ci-paths.generated.json` in the SAME PR; then `node scripts/native/core-closure.mjs --check`
  passes. Without the `--write`+commit, `--check` fails in NATIVE-CI with "stale generated file".
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- **i18n:** 11 locales (ar de en es fr pl pt ru sr tr zh), any new key DE-first (du-form) then mirrored; RTL (`ar`)
  rendered per screen. Reuse the existing `screens.health.*` web keys; the `screens.nativeHealthSync.osPermission.*`
  keys belong to `n5a-health-sync`, not this cluster.
- **Deferred to G1 (owner gate, `next_actor: owner`):** Maestro `maestro/health/*.yaml`, iOS simulator + Android
  emulator screenshots at the device sizes, screenshot parity vs the 390×844 **read-only** staging web screen; listed
  in `docs/validation/<VTID>/staging-tests.json` (sign in, navigate, read; network guard aborts every non-GET except
  sign-in; never `vitanaland.com`). STAGING-VERIFY is read-only by construction (program §6).
- **No What's New entry** (ports of existing screens). No new routes → no nav-registry change and no new native parity
  row — only status flips.

## Open owner / sparring items (not decided here)
- G1 isolated test environment (program gate) — required before any device-runtime parity check; the deferred tasks
  stay `next_actor: owner` until it exists.
- macOS minutes / G3 for iOS-on-device screenshots (program STATUS row 8b) — not needed for the JS build.
- The exact shape of the `n5a-health-sync` module's public read-only entry the in-screen Health Sync affordance calls
  — if N5a has not landed it on main by the time `health-hub` runs, the affordance renders against a typed stub behind
  the ingest-off flag and the dependency is logged (decision 3 / Health Hub coordination). Whether this cluster should
  instead wait for N5a is an owner/sparring call; the plan's default is stub-and-log so the screens land.
<!-- plan:end -->
