---
lane: memory
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(app)/memory/**
  - apps/mobile/src/screens/memory/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/tests/memory/**
  - apps/mobile/maestro/memory/**
  - packages/core/manifest.json
  - packages/core/closure.generated.json
  - packages/core/src/**
  - scripts/native/mobile-ci-paths.generated.json
  - apps/mobile/parity/ledger.json
  - src/i18n/*/memoryNative.json
  - docs/validation/**
updated: 2026-11-01T02:09Z
vtid: VTID-05427
---
# Memory port — the 4 `memory-diary` ledger rows under `/memory*`
Plan: `.kiro/specs/native-wave2-memory-diary-r2/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: memory -->` (tasks 1–8) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start
before `vtid:` is set here.
**Measured on the worktree (= vitana-v1 origin/main, ledger version 2, 435 rows):** 4 ledger rows under
`"lane": "memory-diary"` for this lane, all `not_started` — `MEMORY.OVERVIEW /memory`,
`MEMORY.TIMELINE /memory/timeline`, `MEMORY.RECALL /memory/recall`, `MEMORY.PERMISSIONS /memory/permissions`
(every row `kind: screen`, `scope: in`, `source: registry`, `exception: null`, `owner: null`). Web sources (with
App.tsx cites) in `requirements.md` R0.2: `src/pages/Memory.tsx` (124 lines, route `src/App.tsx:1605`),
`src/pages/memory/Timeline.tsx` (66 lines, `src/App.tsx:1610`), `src/pages/memory/Recall.tsx` (350 lines,
`src/App.tsx:1620`), `src/pages/memory/Permissions.tsx` (62 lines, `src/App.tsx:1625`).
**Goal.** Port the Memory overview, Timeline, Recall and Permissions screens to native on the N3 shell at 1:1
mobile-web parity. Every memory data path is **class-B** (ledger-findings §3: `memory-api`, `memory-learning-api`,
`timeline-api` all import `@/lib/community-gateway`) — re-implemented natively against the native gateway helper in
`apps/mobile/src/auth/gateway.ts` (`getGateway()`/`gatewayGet()`, wrapping `@vitana/core/gateway`'s
`createGatewayFetch`/`gatewayJson`) and the native Supabase client reached through the `core` port
(`@vitana/core/supabase` → `apps/mobile/src/auth/client.ts`) — never a direct `@supabase/supabase-js` import in
screen code — NOT core-extracted. Recall's body is static mock data + an honest empty state (`SpotlightEmpty`),
so it ports as a pure presentational screen. Pillar/catalog text (`timeline-meta.tsx`) and routine phrasing
(`routine-text.ts`) are **mirrored** into DE-first i18n keys, not re-exported (they still pull web-only deps).
Flips all 4 rows to `native`.
**Acceptance (the reviewer agent checks these):**
- Requirements R1–R6 for all 4 destinations; mobile-web parity; `@vitana/core`-only web bridge for any class-A
  helper; class-B data paths re-implemented natively against the core gateway helper + native supabase client
  (ledger-findings §3), never a web component import.
- `npm run typecheck`, `npm test` (overview load/empty/error; timeline load/empty/error; recall static body + empty
  state; permissions switches read/write), `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (from `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/core-closure.mjs --check` and `node scripts/native/parity-ledger.mjs --check` green with all 4
  rows `native` and their routes present in `apps/mobile/app/`.
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form; pt is Brazilian Portuguese você-form)
  then mirrored; RTL (`ar`) covered with start/end only; no hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (this lane's read-only spec) and `plan-sparring.md`.
- **Device-runtime parity (task 8)** is deferred to G1 as `next_actor: owner`; not a merge blocker, recorded in this
  log and `staging-tests.json`.
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 4 rows), `packages/core/manifest.json`
+ closure + `src/**` + `scripts/native/mobile-ci-paths.generated.json` (only this lane's re-exports, if any class-A
helper is promoted; ledger-findings §3 found none, so likely none), `apps/mobile/src/ports/**`,
`apps/mobile/src/navigation/resolve.ts`, and the DE-first i18n shard are shared by row/line; resolve a merge conflict
by keeping both lanes' rows/keys.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only; the native app has no production profile.
## Log
### 2026-11-01T00:05Z · kiro-exafyltd-202611010001-e9e0 · ready
Lane created with the plan (re-plan of `native-wave2-memory-diary/memory`, PR #4322).

### 2026-11-01T02:09Z · ci-plan-spar · ready (VTID allocated)
VTID-05427 allocated after policy approval (converged-auto-v1).
