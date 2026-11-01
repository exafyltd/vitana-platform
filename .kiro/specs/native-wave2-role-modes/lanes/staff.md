---
lane: staff
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(app)/staff/**
  - apps/mobile/src/screens/staff/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/tests/staff/**
  - apps/mobile/maestro/staff/**
  - packages/core/manifest.json
  - packages/core/closure.generated.json
  - packages/core/src/**
  - packages/core/extract.json
  - scripts/native/mobile-ci-paths.generated.json
  - apps/mobile/parity/ledger.json
  - src/i18n/*/staffNative.json
  - docs/validation/**
updated: 2026-10-28T13:40Z
vtid: VTID-05401
---
# Staff-mode port — the 8 `/staff/*` ledger rows (NO bottom tabs)
Plan: `.kiro/specs/native-wave2-role-modes/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: staff -->` (tasks 1–7) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start
before `vtid:` is set here.
**Measured on `exafyltd/vitana-v1` origin/main:** 8 ledger rows under `"lane": "role-modes"` for this lane, all
`not_started`, all `source: role-route` — `/staff/communications`, `/staff/dashboard`, `/staff/queue`,
`/staff/reports`, `/staff/schedule`, `/staff/tasks`, `/staff/time`, `/staff/tools`. Web sources under
`src/pages/staff/*`. Class-B data hooks (import `@/integrations/supabase/client`) re-implemented natively
(design §3b).
**Goal.** Port the staff-mode screens to native on the N3 shell at 1:1 mobile-web parity. **Staff mode has NO bottom
tabs** (its web mode has none, design §2a) — the native staff screens render without a tab bar. Data fetching
re-implemented natively; only the class-A role helpers come from `@vitana/core`. Flips the 8 parity rows to `native`.
**Acceptance (the reviewer seat checks these):**
- Requirements R1–R6 for the 8 staff screens; mobile-web parity; `@vitana/core`-only web bridge (class-A only);
  **no bottom tab bar** rendered for staff mode (design §2a); no data hook added to core.
- `npm run typecheck`, `npm test` (each screen loaded/empty/error; assert no bottom tab bar),
  `APP_PROFILE=development npm run bundle`, `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (from
  `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/parity-ledger.mjs --check` green with the 8 rows `native` and their routes present in
  `apps/mobile/app/`.
- 11 locales (de en es sr fr pl pt ru tr zh ar), new keys DE-first (du-form) then mirrored; register rules (pt você,
  fr tu, ru ты); RTL (`ar`) covered; no hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (this lane's read-only spec) and
  `plan-sparring.md`.
- **Device-runtime parity (task 6)** is deferred to G1 as `next_actor: owner`; not a merge blocker, recorded in this
  log and `staging-tests.json`.
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 8 rows), `packages/core/**` (this lane
adds no new core entry), and the DE-first i18n shard are shared by row/line; resolve a merge conflict by keeping both
lanes' rows/keys.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only; the native app has no production profile.
## Log
### 2026-10-28T00:00Z · kiro-planner · re-created → ready
Lane re-drafted with the plan (`state: drafted` in `handoff.md`) after the earlier spec was lost. The 8 rows and the
paths were computed from the origin/main parity ledger so no file belongs to two lanes; no `depends_on` — runs in
parallel with the other three lanes. Next: PLAN-SPAR spars the plan; once a VTID is written here, seat `exafyltd`
claims the lane (`queue.mjs claim native-wave2-role-modes/staff --session <id>`).

### 2026-10-28T13:40Z · ci-plan-spar · ready (VTID allocated)
VTID-05401 allocated after policy approval (converged-auto-v1).
