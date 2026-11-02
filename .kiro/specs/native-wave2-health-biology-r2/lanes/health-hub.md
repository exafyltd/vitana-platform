---
lane: health-hub
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
  - packages/core/manifest.json
  - packages/core/closure.generated.json
  - packages/core/src/**
  - scripts/native/mobile-ci-paths.generated.json
  - apps/mobile/parity/ledger.json
  - src/i18n/*/healthNative.json
  - docs/validation/**
  - packages/core/extract.json
updated: 2026-11-01T17:20Z
---
# Health dashboard + Vitana Index overlay port — `/health` (+ mode tabs) + `OVERLAY.VITANA_INDEX`
Plan: `.kiro/specs/native-wave2-health-biology-r2/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: health-hub -->` (tasks 1–10) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not
start before `vtid:` is set here.
**Measured on the worktree (= origin/main):** 4 ledger rows under `"lane": "health"` for this lane, all `not_started`
— `HEALTH.OVERVIEW /health`, `HEALTH.MEDICAL /health?mode=medical`, `HEALTH.SUPPLEMENTS /health?mode=supplements`, and
the overlay `OVERLAY.VITANA_INDEX /health`. Web source `src/pages/Health.tsx` (mobile branch: `MobileModePill`
overview/medical/supplements, `MobileHealthSnapshot`/`MobilePriorityFocus`/`MobileAutopilotGuidance`,
`MobileHealthMedicalTab`/`MobileHealthSupplementsTab`, `HealthReportUploadSheet`/`QuickLabOrderSheet`); overlay
`src/components/health/VitanaIndexSheet.tsx` (496) + `VitanaIndexProvider.tsx`; chips
`src/components/mobile/MobileActionChips.tsx` (`VitanaIndexChip`/`AutopilotChip`).
**Goal.** Port the Health dashboard to native on the N3 shell at 1:1 mobile-web parity: the `MobileModePill`
overview/medical/supplements tabs (the `?mode=` states are the `HEALTH.MEDICAL`/`HEALTH.SUPPLEMENTS` rows, resolved via
`normalizeHealthMode`), the snapshot/priority/guidance widgets, the medical/supplements mobile tabs, and the header
Vitana Index + Autopilot chips; plus the Vitana Index **overlay** twin. **This lane also owns** the core extraction
(pure Vitana Index math + biology-card helpers), the native health-data fetch + consent gate (consumed by
`vitana-index-biology` via a port), the chip twins, and the in-screen Health Sync affordance. Flips the 4 parity rows
to `native`.
**Health Hub boundary (read `plan.md` "Health Hub coordination").** Health-data reads (Vitana Index, profile health
summary, supplements) use the native Supabase client + native auth, RLS-scoped `user_id = auth.uid()`, consent
respected, reads only — the health-data hooks are class B (runtime-import `@/integrations/supabase/client.ts`) and are
NOT moved to core. The in-screen "Connect Apple Health / Health Connect / device" affordance **delegates to the
`n5a-health-sync` module (VTID-05184)**; it never requests an OS permission or ingests here. If that module's public
read-only-until-enabled entry is not yet on main, render the affordance against a typed stub behind the ingest-off flag
and log the dependency. The standalone Connected Apps / `/connectors?tab=health` screens are NOT in this cluster
(ledger lane `profile-settings-support`). Nothing is written to production.
**Acceptance (the reviewer seat checks these):**
- 1:1 mobile-web parity for `/health` (+ the two `?mode=` tabs) and the Vitana Index overlay; `@vitana/core`-only web
  bridge; the native health-data module + chip twins + Health Sync affordance owned here (one owner).
- `npm run typecheck`, `npm test` (dashboard loaded/empty/error; overview/medical/supplements mode-tab switch;
  snapshot/priority/guidance widgets; overlay open/dismiss + data render; Health Sync affordance resolves to the module
  entry behind the ingest-off flag; **consent/no-write test** — RLS-scoped reads, no non-GET, no OS permission/ingest),
  `APP_PROFILE=development npm run bundle`, `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (all from
  `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/core-closure.mjs --check` (after `--write` + committing the regenerated
  `closure.generated.json` and `mobile-ci-paths.generated.json`) and `node scripts/native/parity-ledger.mjs --check`
  green with the 4 rows `native` and their routes present in `apps/mobile/app/`.
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form) then mirrored; RTL (`ar`) covered; no
  hardcoded user-visible text; no physical `left`/`right`; no `screens.nativeHealthSync.osPermission.*` key added
  (that is N5a's).
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json` (every touched path), `staging-tests.json` (this lane's read-only spec)
  and `plan-sparring.md` (copy of the plan's sparring record).
- **Device-runtime parity (task 9)** — Maestro + sim/emulator screenshots + parity vs 390×844 staging — is deferred to
  G1 as `next_actor: owner`; not a merge blocker for the port, recorded in this log and `staging-tests.json`.
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 4 rows), `packages/core/manifest.json` +
closure + `src/**` + `scripts/native/mobile-ci-paths.generated.json` (only this lane's re-exports — the pure helpers),
`apps/mobile/src/ports/**` + `resolve.ts`, and the DE-first i18n shard are shared by row/line with the other two lanes;
resolve a merge conflict by keeping both lanes' rows/keys.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only; the native app has no production profile;
class-B modules (anything runtime-importing `@/integrations/supabase/client.ts`) are NEVER moved into core.
## Log
### 2026-11-01T17:20Z · kiro-exafyltd-202611011658-9f52 · ready
Lane created with the plan (re-plan of `native-wave2-health-biology/health-hub`, PR #4272); `paths` widened to the shared native-infra files.
