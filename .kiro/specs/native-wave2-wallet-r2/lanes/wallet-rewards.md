---
lane: wallet-rewards
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(app)/wallet/rewards.tsx
  - apps/mobile/app/(app)/redeem.tsx
  - apps/mobile/src/screens/wallet-rewards/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/tests/wallet-rewards/**
  - apps/mobile/maestro/wallet-rewards/**
  - packages/core/manifest.json
  - packages/core/closure.generated.json
  - packages/core/src/**
  - scripts/native/mobile-ci-paths.generated.json
  - apps/mobile/parity/ledger.json
  - src/i18n/*/walletRewardsNative.json
  - docs/validation/**
updated: 2026-11-01T00:05Z
---
# Rewards + redeem port — `/wallet/rewards` (+ earn/shop tabs) and `/redeem`
Plan: `.kiro/specs/native-wave2-wallet-r2/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: wallet-rewards -->` (tasks 1–7) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not
start before `vtid:` is set here.
**Measured against `exafyltd/vitana-v1` `origin/main`:** 4 ledger rows under `"lane": "wallet"` for this lane, all
`not_started` — `WALLET.REWARDS /wallet/rewards`, `WALLET.REWARDS_EARN_MORE /wallet/rewards?tab=earn`,
`WALLET.REWARDS_SHOP /wallet/rewards?tab=shop`, and the exclusion route `/redeem`. Web sources
`src/pages/wallet/Rewards.tsx` (137 lines; route `src/App.tsx:1573-1577`, lazy import `:288`),
`src/pages/RedeemVoucher.tsx` (206 lines; route `src/App.tsx:849`, lazy import `:89`). Rewards imports
`isIAPRestricted` (shop purchase branched); RedeemVoucher does not (a code-claim, not a purchase → ungated).
**Goal.** Port the rewards screen (earn/shop tabs) and the voucher-redeem screen to native on the N3 shell at 1:1
mobile-web parity. **Preserve the `isIAPRestricted` branch on the rewards shop purchase exactly** (R3.2) — shop
purchase hidden/branched on iOS as the web does, the earn-more tab stays visible; `/redeem` stays **ungated** (no IAP
concern — a code-claim). No gate added, removed, widened or narrowed. Flips both the 3 rewards rows and `/redeem` to
`native` (4 rows).
**Acceptance (the reviewer seat checks these):**
- Requirements R1–R7 for `/wallet/rewards` (+ tabs) and `/redeem`; mobile-web parity; `@vitana/core`-only web bridge;
  **the rewards-shop iOS gate mirrored 1:1; redeem ungated as today**.
- `npm run typecheck`, `npm test` (rewards earn/shop tab switch; **shop gated on iOS, shown off iOS**; redeem code
  valid/invalid/already-claimed/error), `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (all from `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/core-closure.mjs --check` and `node scripts/native/parity-ledger.mjs --check` green with all 4
  rows `native` (incl. the `?tab=` rows) and their routes present in `apps/mobile/app/`.
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form; pt você-form) then mirrored; RTL (`ar`)
  covered; no hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (this lane's read-only spec) and `plan-sparring.md`.
- **Device-runtime parity (task 6)** is deferred to G1 as `next_actor: owner`; not a merge blocker, recorded in this
  log and `staging-tests.json`.
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 4 rows), `packages/core/manifest.json`
+ closure + `src/**` (this lane adds **no** core re-export — `wallet-home` owns the extraction; listed only so a
reused key resolves), and the DE-first i18n shard are shared by row/line; resolve a merge conflict by keeping both
lanes' rows/keys.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only; the native app has no production profile; no
new wallet route (NEVER rule 26); no `isIAPRestricted` gate behaviour change.
## Log
### 2026-11-01T00:05Z · kiro-exafyltd-202611010001-e4d4 · ready
Lane created with the plan (re-plan of `native-wave2-wallet/wallet-rewards`, PR #4332).
