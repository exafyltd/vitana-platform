---
lane: wallet-redeem
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(public)/redeem.tsx
  - apps/mobile/src/screens/wallet-redeem/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/tests/wallet-redeem/**
  - apps/mobile/maestro/wallet-redeem/**
  - packages/core/manifest.json
  - packages/core/closure.generated.json
  - packages/core/src/**
  - scripts/native/mobile-ci-paths.generated.json
  - apps/mobile/parity/ledger.json
  - src/i18n/*/walletRedeemNative.json
  - docs/validation/**
updated: 2026-11-01T02:06Z
vtid: VTID-05423
---
# Public voucher redeem port — `/redeem` in the `(public)` group
Plan: `.kiro/specs/native-wave2-wallet-r2/` — `plan.md` (plan block, decision 2a) and the `tasks.md` section marked
`<!-- lane: wallet-redeem -->` (tasks 1–6) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not
start before `vtid:` is set here.
**Measured against `exafyltd/vitana-v1` `origin/main`:** 1 ledger row under `"lane": "wallet"` for this lane, the
exclusion route `/redeem` (`not_started`). Web source `src/pages/RedeemVoucher.tsx` (206 lines; route
`src/App.tsx:849` in the "Public Routes - No Auth Required" block, no `AuthGuard`; lazy import `:89`). No
`isIAPRestricted` import (a code-claim, not a purchase → ungated).
**Goal.** Port the voucher-redeem screen to native at 1:1 mobile-web parity as `apps/mobile/app/(public)/redeem.tsx`
(the `(public)` group: `Stack`, `headerShown: false`, no shell chrome, no auth — where the native `/reset-password`
and `/logout` twins already live). An unauthenticated member reaches it exactly as on web. Ungated; no gate added.
Flips `/redeem` to `native` (1 row).
**Acceptance (the reviewer seat checks these):**
- Requirements R1–R7 for `/redeem`; mobile-web parity; `@vitana/core`-only web bridge; ungated as today; renders
  without an authenticated session; the route file is in `(public)`, not `(app)`.
- `npm run typecheck`, `npm test` (redeem code valid/invalid/already-claimed/error; unauthenticated render),
  `APP_PROFILE=development npm run bundle`, `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (all
  from `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/parity-ledger.mjs --check` green with `/redeem` `native` and its route present in
  `apps/mobile/app/`.
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form; pt você-form) then mirrored; RTL (`ar`)
  covered; no hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (this lane's read-only spec) and `plan-sparring.md`.
- **Device-runtime parity (task 5)** is deferred to G1 as `next_actor: owner`; not a merge blocker.
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only the `/redeem` row), `packages/core/**`
(no core re-export here; listed only so a reused key resolves), and the DE-first i18n shard; resolve a merge conflict
by keeping both lanes' rows/keys.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only; no voucher claimed on staging; the native app
has no production profile; no new wallet route (NEVER rule 26).
## Log
### 2026-11-01T01:12Z · kiro-exafyltd-202611010001-e4d4 · ready
Lane created with the plan (r2 sparring R1-F1: `/redeem` moved out of `wallet-rewards` into its own lane, in the
`(public)` group).

### 2026-11-01T02:06Z · ci-plan-spar · ready (VTID allocated)
VTID-05423 allocated after policy approval (converged-auto-v1).
