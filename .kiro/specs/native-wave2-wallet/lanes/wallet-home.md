---
lane: wallet-home
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(app)/wallet/index.tsx
  - apps/mobile/app/(app)/wallet/balance.tsx
  - apps/mobile/src/screens/wallet-home/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/tests/wallet-home/**
  - apps/mobile/maestro/wallet-home/**
  - packages/core/manifest.json
  - packages/core/closure.generated.json
  - packages/core/src/**
  - scripts/native/mobile-ci-paths.generated.json
  - apps/mobile/parity/ledger.json
  - src/i18n/*/walletHomeNative.json
  - docs/validation/**
updated: 2026-10-22T13:00Z
---
# Wallet hub + balance port — `/wallet` (+ popup overlay, tabs) and `/wallet/balance` (+ tabs); owns the core extraction
Plan: `.kiro/specs/native-wave2-wallet/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: wallet-home -->` (tasks 1–8) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not
start before `vtid:` is set here.
**Measured against `exafyltd/vitana-v1` `origin/main`:** 8 ledger rows under `"lane": "wallet"` for this lane, all
`not_started` — `WALLET.OVERVIEW /wallet`, `OVERLAY.WALLET_POPUP /wallet`, `WALLET.ACTIONS /wallet?tab=actions`,
`WALLET.ACTIVITY /wallet?tab=activity`, `WALLET.BALANCE /wallet/balance`,
`WALLET.BALANCE_MEMBERSHIP /wallet/balance?tab=membership`,
`WALLET.BALANCE_OPTIMIZATION /wallet/balance?tab=optimization`, `WALLET.BALANCE_TOKENS /wallet/balance?tab=tokens`.
Web sources `src/pages/Wallet.tsx` (970 lines; route `src/App.tsx:1558-1562`, lazy import `:199`),
`src/pages/wallet/Balance.tsx` (491 lines; route `src/App.tsx:1563-1567`, lazy import `:286`). Pure helper reused from
`@vitana/core`: `src/lib/exchangeRates.ts` (117, class-A, no IO). Data fetch (`useWallet`, `useWalletGateway`,
`useDisplayCurrency`, `useEurUsdRate`) is class-B and re-implemented natively; `src/lib/appilix.ts`
(`isIAPRestricted`/`isIOSApp`) is class-B — not extracted, mirrored via the native platform-detection equivalent.
**Goal.** Port the wallet hub + balance detail to native on the N3 shell at 1:1 mobile-web parity: balance summary,
quick actions, activity list, the `actions`/`activity` and `membership`/`optimization`/`tokens` tabs via the `tab`
search param, the `WalletPopup` overlay, and the add-funds/buy/withdraw/spend flows as native bottom sheets. **Every
`isIAPRestricted()` branch is mirrored one-for-one** (R3.2) — on iOS the add-funds/buy/withdraw/deposit actions and
the quick-exchange widget are hidden, and `Balance`'s `if (isIAPRestricted()) return null` on the top-up affordance is
preserved; no gate is added, removed, widened or narrowed. **Owns the core extraction** (task 1): adds the
`exchangeRates` re-export to `@vitana/core` and commits the regenerated `closure.generated.json` +
`mobile-ci-paths.generated.json` in the same PR. Flips the 8 parity rows to `native`.
**Acceptance (the reviewer seat checks these):**
- Requirements R1–R7 for the wallet hub + balance; mobile-web parity; `@vitana/core`-only web bridge; `exchangeRates`
  consumed from core; data fetch re-implemented natively; **the iOS-IAP gate mirrored 1:1**.
- `npm run typecheck`, `npm test` (hub loaded/empty/error; **`isIAPRestricted` gate tested both ways — iOS hides
  add-funds/buy/withdraw + quick-exchange, non-iOS shows them**; balance tabs; `exchangeRates` pure-module tests),
  `APP_PROFILE=development npm run bundle`, `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (from
  `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/core-closure.mjs --check` and `node scripts/native/parity-ledger.mjs --check` green with the 8
  rows `native` (incl. the `?tab=` rows and `OVERLAY.WALLET_POPUP`) and their routes present in `apps/mobile/app/`.
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form; pt você-form) then mirrored; RTL (`ar`)
  covered; no hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (this lane's read-only spec) and `plan-sparring.md`.
- **Device-runtime parity (task 7)** is deferred to G1 as `next_actor: owner`; not a merge blocker, recorded in this
  log and `staging-tests.json`.
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 8 rows), `packages/core/manifest.json`
+ closure + `src/**` (this lane owns the `exchangeRates` re-export + the regenerated generated files), and the
DE-first i18n shard are shared by row/line; resolve a merge conflict by keeping both lanes' rows/keys.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only; the native app has no production profile; no
new wallet route (NEVER rule 26); no `isIAPRestricted` gate behaviour change.
## Log
### 2026-10-22T13:00Z · kiro-202610151913-51bd · created → ready
Lane drafted with the plan (`state: drafted` in `handoff.md`). The 8 rows and the paths were computed from the parity
ledger on `origin/main` and `src/App.tsx` so no file belongs to two lanes; no inter-lane dependency. This lane owns
the `exchangeRates` core re-export (the only class-A wallet helper). Next: PLAN-SPAR spars the plan; once a VTID is
written here, seat `exafyltd` claims the lane (`queue.mjs claim native-wave2-wallet/wallet-home --session <id>`).
Runs in parallel with `wallet-rewards` and `wallet-subscriptions`.
