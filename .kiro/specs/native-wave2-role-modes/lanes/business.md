---
lane: business
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(app)/commerce/**
  - apps/mobile/app/(app)/commerce-login.tsx
  - apps/mobile/src/screens/business/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/tests/business/**
  - apps/mobile/maestro/business/**
  - packages/core/manifest.json
  - packages/core/closure.generated.json
  - packages/core/src/**
  - packages/core/extract.json
  - scripts/native/mobile-ci-paths.generated.json
  - apps/mobile/parity/ledger.json
  - src/i18n/*/businessNative.json
  - docs/validation/**
updated: 2026-10-28T13:40Z
vtid: VTID-05398
---
# Business / commerce-mode port — the 11 commerce ledger rows; owns the one new class-A core extraction
Plan: `.kiro/specs/native-wave2-role-modes/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: business -->` (tasks 1–8) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start
before `vtid:` is set here.
**Measured on `exafyltd/vitana-v1` origin/main:** 11 ledger rows under `"lane": "role-modes"` for this lane, all
`not_started` (10 `source: role-route` + 1 `source: exclusion`) — **4 core commerce rows** `/commerce`,
`/commerce-login`, `/commerce/health-orders`, `/commerce/health-orders/inbox`; **7 join/invite/connect/team/connections
rows** `/commerce/connect`, `/commerce/connect/privacy`, `/commerce/connect/authorize` (the `source: exclusion`
row), `/commerce/connections/:id`, `/commerce/invites/:token/accept`, `/commerce/join`, `/commerce/team`. Web sources
under `src/pages/` commerce screens. Class-A chrome modules on origin/main: `src/lib/business-mode.ts` and
`src/config/drawer-nav.config.ts` are already in `packages/core/src/extracted/*.generated.ts`; `src/lib/permissions.ts`
is already re-exported in `packages/core/manifest.json`; `src/lib/role-switch-destination.ts` is the one new class-A
extraction this lane adds. Class-B data hooks (`useActivateReseller`, `useResellerSales`; import
`@/integrations/supabase/client`) re-implemented natively (design §3b).
**Goal.** Port the business / commerce-mode screens to native on the N3 shell at 1:1 mobile-web parity, with the
business bottom tabs wired via the core `business-mode` / `drawer-nav` helpers and the role switch via the newly
extracted `role-switch-destination`. **This lane owns the only new class-A core extraction** (task 1) — adds the
`role-switch-destination` re-export + manifest line, runs `core-closure.mjs --write` and commits the regenerated
generated files in the same PR. Data fetching re-implemented natively. Flips all 11 parity rows to `native`
(including the `source: exclusion` row `/commerce/connect/authorize` — only its `status` changes, `scope` stays
`in`).
**Acceptance (the reviewer seat checks these):**
- Requirements R1–R6 for the 11 commerce destinations; mobile-web parity; `@vitana/core`-only web bridge (class-A
  only); business bottom tabs present (design §2a); the one new core entry (`role-switch-destination`) added with
  `--write` + committed generated files in the same PR; no data hook added to core.
- `npm run typecheck`, `npm test` (each screen loaded/empty/error; bottom tabs present; connect/authorize and
  invite/accept deep-links resolve; `role-switch-destination` helper unit test),
  `APP_PROFILE=development npm run bundle`, `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (from
  `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/core-closure.mjs --check` and `node scripts/native/parity-ledger.mjs --check` green with all
  11 rows `native` and their routes present in `apps/mobile/app/`.
- 11 locales (de en es sr fr pl pt ru tr zh ar), new keys DE-first (du-form) then mirrored; register rules (pt você,
  fr tu, ru ты); RTL (`ar`) covered; no hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (this lane's read-only spec) and
  `plan-sparring.md`.
- **Device-runtime parity (task 7)** is deferred to G1 as `next_actor: owner`; not a merge blocker, recorded in this
  log and `staging-tests.json`.
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 11 rows — including the one exclusion
row's `status`), `packages/core/manifest.json` + closure + `src/**` (this lane adds the one new class-A re-export,
`role-switch-destination`, and runs `--write`), `scripts/native/mobile-ci-paths.generated.json`, and the DE-first
i18n shard are shared by row/line; resolve a merge conflict by keeping both lanes' rows/keys.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only; the native app has no production profile.
## Log
### 2026-10-28T00:00Z · kiro-planner · re-created → ready
Lane re-drafted with the plan (`state: drafted` in `handoff.md`) after the earlier spec was lost. The 11 rows (incl.
the one `source: exclusion` row this lane flips) and the paths were computed from the origin/main parity ledger so no
file belongs to two lanes; no `depends_on` — runs in parallel with the other three lanes. The one new class-A core
extraction (`role-switch-destination.ts`) is owned here. Next: PLAN-SPAR spars the plan; once a VTID is written here,
seat `exafyltd` claims the lane (`queue.mjs claim native-wave2-role-modes/business --session <id>`).

### 2026-10-28T13:40Z · ci-plan-spar · ready (VTID allocated)
VTID-05398 allocated after policy approval (converged-auto-v1).
