---
lane: vitana-index-biology
state: ready
next_actor: kiro
depends_on: [health-hub]
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
# Vitana Index detail + biology port — `/health/vitana-index`, `/health/my-biology` (+ tabs)
Plan: `.kiro/specs/native-wave2-health-biology-r2/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: vitana-index-biology -->` (tasks 1–7) are authoritative. VTID: assigned by CI after PLAN-SPAR converges;
do not start before `vtid:` is set here. **depends_on `health-hub`:** this lane consumes the native Vitana Index
data module + the chip twins that `health-hub` owns (decision 3) — start only after `health-hub` is `done`.
**Measured on the worktree (= origin/main):** 4 ledger rows under `"lane": "health"` for this lane, all `not_started`
— `HEALTH.VITANA_INDEX /health/vitana-index`, `HEALTH.MY_BIOLOGY /health/my-biology`, `HEALTH.BIOLOGY_OMICS
/health/my-biology?tab=omics`, `HEALTH.BIOLOGY_SUPPLEMENTS /health/my-biology?tab=supplements`. Web sources
`src/pages/health/VitanaIndexDetail.tsx` (726 lines, route `src/App.tsx:1162`), `src/pages/health/MyBiology.tsx`
(medical/omics/supplements tabs, reads `lab_reports` + supplements, route `src/App.tsx:1152`).
**Goal.** Port the Vitana Index detail page and the biology screen to native on the N3 shell at 1:1 mobile-web parity:
the index pillar breakdown / trajectory / log-data dialog / pillar agents panel, consuming the consented Index data
from `health-hub`'s native data module (port, not a new fetch); and the biology medical/omics/supplements tabs via the
`tab` search param (`HEALTH.BIOLOGY_OMICS`/`HEALTH.BIOLOGY_SUPPLEMENTS` are `?tab=` states) with the RLS-scoped
`lab_reports` + supplements lists and write-disabled upload/add affordances. Flips the 4 parity rows to `native`.
**Health Hub boundary (read `plan.md` "Health Hub coordination").** All health-data reads are RLS-scoped
`user_id = auth.uid()`, consent respected, reads only; the health-data hooks are class B and are NOT moved to core —
this lane reuses `health-hub`'s native data module via a port. Upload / add-supplement affordances are presented but
write-disabled; nothing is written to production. No OS permission / ingest here.
**Acceptance (the reviewer seat checks these):**
- 1:1 mobile-web parity for `/health/vitana-index` and `/health/my-biology` (+ the two `?tab=` states); `@vitana/core`-
  only web bridge; the Index data consumed from `health-hub`'s native module (not re-fetched/re-owned here).
- `npm run typecheck`, `npm test` (index pillar breakdown + log-data dialog; biology medical/omics/supplements tab
  switch loaded/empty/error; lab-report read is RLS-scoped, no non-GET; supplement list loaded/empty),
  `APP_PROFILE=development npm run bundle`, `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (all from
  `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/core-closure.mjs --check` and `node scripts/native/parity-ledger.mjs --check` green with the 4
  rows `native` and their routes present in `apps/mobile/app/`.
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form) then mirrored; RTL (`ar`) covered; no
  hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (read-only) and `plan-sparring.md`.
- **Device-runtime parity (task 6)** is deferred to G1 as `next_actor: owner`; not a merge blocker, recorded in this
  log and `staging-tests.json`.
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 4 rows), `packages/core/manifest.json` +
closure + `src/**` (only re-exports this lane adds, if any — the pure helpers are owned by `health-hub`),
`apps/mobile/src/ports/**` + `resolve.ts`, and the DE-first i18n shard are shared by row/line; resolve a merge conflict
by keeping both lanes' rows/keys. This lane shares the `apps/mobile/src/screens/health/**` subtree with `health-hub` —
own only the `VitanaIndexDetailScreen.tsx` / `MyBiologyScreen.tsx` files and their own `__tests__`, never the dashboard
/ overlay / data-module files `health-hub` owns.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only; the native app has no production profile;
class-B modules are NEVER moved into core.
## Log
### 2026-11-01T17:20Z · kiro-exafyltd-202611011658-9f52 · ready
Lane created with the plan (re-plan of `native-wave2-health-biology/vitana-index-biology`, PR #4272); `paths` widened to the shared native-infra files.
