# Tasks — Native Wave 2: Wallet screen ports

Three lanes, disjoint `paths`. Design: `design.md` and `requirements.md` in this folder are authoritative — follow
them exactly; anything outside them is a plan change (log it, set `next_actor: kiro` and re-spar). VTIDs are assigned
by CI after PLAN-SPAR converges; do not start a lane before its `vtid:` is set in `lanes/<id>.md`. All commands run
from `apps/mobile/` unless noted; `assertNotProduction()` and the no-production-profile rule make every command
offline. **iOS-IAP gating is preserved 1:1 — no task adds, removes, widens or narrows an `isIAPRestricted` gate**
(R3); the per-surface decision-5 classification is recorded, not acted on.

<!-- lane: wallet-home -->
## Lane `wallet-home` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports (8 ledger rows under `"lane": "wallet"`): `WALLET.OVERVIEW /wallet`, `OVERLAY.WALLET_POPUP /wallet`,
`WALLET.ACTIONS /wallet?tab=actions`, `WALLET.ACTIVITY /wallet?tab=activity`, `WALLET.BALANCE /wallet/balance`,
`WALLET.BALANCE_MEMBERSHIP /wallet/balance?tab=membership`, `WALLET.BALANCE_OPTIMIZATION /wallet/balance?tab=optimization`,
`WALLET.BALANCE_TOKENS /wallet/balance?tab=tokens`. depends_on: none. Web sources `src/pages/Wallet.tsx` (970 lines,
route `src/App.tsx:1558-1562`), `src/pages/wallet/Balance.tsx` (491 lines, route `src/App.tsx:1563-1567`). **This lane
owns the core extraction** of `src/lib/exchangeRates.ts` (decision 4).

- [ ] 1. Re-export the one pure helper through `@vitana/core`: add a manifest line for `src/lib/exchangeRates.ts`
  (class-A, IO-free — `convertFromUsd`, `getCurrencySymbol`) with a re-export in `packages/core/src/exchangeRates.ts`,
  then `node scripts/native/core-closure.mjs --write` and commit the regenerated
  `packages/core/closure.generated.json` and `scripts/native/mobile-ci-paths.generated.json` in the SAME PR. Do NOT
  extract the data hooks (`useWallet`, `useWalletGateway`, `useDisplayCurrency`, `useEurUsdRate`) or `appilix.ts` —
  they are class-B and re-implemented natively.
  Files: `packages/core/manifest.json`, `packages/core/src/**`, `packages/core/closure.generated.json`,
  `scripts/native/mobile-ci-paths.generated.json`.
  Verify (repo root): `node scripts/native/core-closure.mjs --check` passes; `apps/mobile` → `npm run typecheck` green.
- [ ] 2. Native wallet hub `apps/mobile/app/(app)/wallet/index.tsx` + `apps/mobile/src/screens/wallet-home/WalletScreen.tsx`:
  twin of the mobile-web branch of `Wallet.tsx` on the N3 shell — balance summary, quick actions, activity list, the
  `actions`/`activity` tabs via the `tab` search param, the `WalletPopup` overlay (`OVERLAY.WALLET_POPUP`) in the
  shell's overlay slot, and the add-funds / buy-credits / withdraw / spend flows as native bottom sheets. **Mirror
  every `isIAPRestricted()` branch one-for-one** (R3.2): on iOS hide the add-funds/buy/withdraw/deposit primary
  actions and the quick-exchange widget exactly as the web hides them; balance + activity stay visible. Currency
  conversion from `@vitana/core` (`exchangeRates`); balance/activity fetch re-implemented natively (class-B).
  Files: `apps/mobile/app/(app)/wallet/index.tsx`, `apps/mobile/src/screens/wallet-home/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 3. Native balance detail `apps/mobile/app/(app)/wallet/balance.tsx` +
  `apps/mobile/src/screens/wallet-home/BalanceScreen.tsx`: twin of `Balance.tsx`, the `membership`/`optimization`/`tokens`
  tabs via the `tab` search param (`useUrlTab` equivalent). **Preserve the `if (isIAPRestricted()) return null` on the
  top-up/optimization affordance and the gated `spotlightAction` exactly** (R3.2); the membership tab (real-world
  service) stays visible.
  Files: `apps/mobile/app/(app)/wallet/balance.tsx`, `apps/mobile/src/screens/wallet-home/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 4. i18n + RTL: user-visible strings from the web shards; any genuinely new key added to `src/i18n/de/*.json`
  first (du-form; pt Brazilian você-form), then the other ten (ar de en es fr pl pt ru sr tr zh); render under `ar`
  with start/end only; no hardcoded text, no physical `left`/`right`.
  Files: `src/i18n/*/walletHomeNative.json` (DE first), `apps/mobile/src/screens/wallet-home/**`.
  Verify: `npm run typecheck`; `npm test` — the no-raw-text and no-physical-direction tests pass.
- [ ] 5. Unit tests (fake gateway / fixtures, no network): wallet hub loaded/empty/error; **the `isIAPRestricted` gate
  tested both ways — iOS-gated fixture hides add-funds/buy/withdraw + quick-exchange, non-iOS fixture shows them
  (the parity assertion)**; balance tabs switch; `if (isIAPRestricted()) return null` on the top-up affordance;
  `exchangeRates` pure-module tests (`convertFromUsd`, `getCurrencySymbol`). React 19 — `ReactElement`, no global `JSX`.
  Files: `apps/mobile/tests/wallet-home/**`, `apps/mobile/src/screens/wallet-home/__tests__/**`.
  Verify: `npm test` green; `APP_PROFILE=development npm run bundle` and
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 6. Flip the lane's 8 parity rows to `native` and verify: `node scripts/native/parity-ledger.mjs --sync` (status
  edited by hand to `native`), then `--check`. Flip every row including the `?tab=` rows and `OVERLAY.WALLET_POPUP`,
  not only the base rows.
  Files: `apps/mobile/parity/ledger.json` (wallet-home rows only), `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 7. **(depends-on-owner / G1 — `next_actor: owner`)** Device-runtime parity: Maestro journey(s)
  `apps/mobile/maestro/wallet-home/*.yaml`, iOS simulator + Android emulator screenshots at the device sizes,
  screenshot parity vs the 390×844 read-only staging web `/wallet` and `/wallet/balance` (read-only; no purchase
  attempted — the iOS-gated state is verified, not exercised). Blocked until G1 (and macOS minutes / G3 for iOS on a
  device).
  Files: `apps/mobile/maestro/wallet-home/**`, `docs/validation/<VTID>/staging-tests.json`.
  Verify: on G1 only; recorded in the lane log, not run in CI.
- [ ] 8. PR: branch `kiro/native-wave2-wallet/wallet-home`, title
  `VTID-xxxxx (native-wave2-wallet/wallet-home): native wallet hub + balance port (iOS IAP gates preserved)`, body
  names the Kiro session id, Summary / Decisions taken / Tests / Handoff. Commit trailers `Collab-Session: <kiro id>`,
  `Collab-Lane: native-wave2-wallet/wallet-home`. Lane → `in-review`, `next_actor: kiro` (reviewer seat `hotmail`).
  Never merge, deploy or write to a live system (protocol §7a).

<!-- lane: wallet-rewards -->
## Lane `wallet-rewards` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports (4 ledger rows): `WALLET.REWARDS /wallet/rewards`, `WALLET.REWARDS_EARN_MORE /wallet/rewards?tab=earn`,
`WALLET.REWARDS_SHOP /wallet/rewards?tab=shop`, `/redeem`. depends_on: none. Web sources
`src/pages/wallet/Rewards.tsx` (137 lines, route `src/App.tsx:1573-1577`), `src/pages/RedeemVoucher.tsx` (206 lines,
route `src/App.tsx:849`).

- [ ] 1. Native rewards `apps/mobile/app/(app)/wallet/rewards.tsx` +
  `apps/mobile/src/screens/wallet-rewards/RewardsScreen.tsx`: twin of `Rewards.tsx`, `earn`/`shop` tabs via the `tab`
  search param. **Preserve the `isIAPRestricted` branch on the shop purchase affordance exactly** (R3.2): shop
  purchase hidden/branched on iOS as the web does; the earn-more (non-purchase) tab stays visible. Consume core / N2
  only; no web import.
  Files: `apps/mobile/app/(app)/wallet/rewards.tsx`, `apps/mobile/src/screens/wallet-rewards/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 2. Native redeem `apps/mobile/app/(app)/redeem.tsx` +
  `apps/mobile/src/screens/wallet-rewards/RedeemScreen.tsx`: twin of `RedeemVoucher.tsx` — voucher code entry, lookup
  (`useVoucherByCode` equivalent, re-implemented natively), claim (`useClaimVoucher`). A code-claim, **not a purchase
  → ungated** (no IAP concern); do not add a gate.
  Files: `apps/mobile/app/(app)/redeem.tsx`, `apps/mobile/src/screens/wallet-rewards/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 3. i18n + RTL (as wallet-home task 4) for rewards + redeem.
  Files: `src/i18n/*/walletRewardsNative.json` (DE first), `apps/mobile/src/screens/wallet-rewards/**`.
  Verify: `npm run typecheck`; `npm test` no-raw-text / no-physical-direction tests pass.
- [ ] 4. Unit tests (fake gateway / fixtures): rewards earn/shop tab switch; **shop purchase gated on iOS, shown off
  iOS (parity assertion)**; redeem code valid / invalid / already-claimed / error. React 19 `ReactElement`.
  Files: `apps/mobile/tests/wallet-rewards/**`, `apps/mobile/src/screens/wallet-rewards/__tests__/**`.
  Verify: `npm test`; `APP_PROFILE=development npm run bundle`;
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 5. Flip the lane's 4 parity rows (`WALLET.REWARDS`, `WALLET.REWARDS_EARN_MORE`, `WALLET.REWARDS_SHOP`,
  `/redeem`) to `native`; `--sync` then `--check`.
  Files: `apps/mobile/parity/ledger.json` (wallet-rewards rows only), `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 6. **(depends-on-owner / G1 — `next_actor: owner`)** Maestro `apps/mobile/maestro/wallet-rewards/*.yaml` +
  sim/emulator screenshots + parity vs 390×844 staging `/wallet/rewards` and `/redeem` (read-only; no purchase
  attempted). Blocked until G1 (+ macOS/G3 for iOS).
  Files: `apps/mobile/maestro/wallet-rewards/**`, `docs/validation/<VTID>/staging-tests.json`.
- [ ] 7. PR: branch `kiro/native-wave2-wallet/wallet-rewards`, title
  `VTID-xxxxx (native-wave2-wallet/wallet-rewards): native rewards + redeem port (iOS IAP gates preserved)`; trailers
  `Collab-Session`, `Collab-Lane: native-wave2-wallet/wallet-rewards`; lane → `in-review`, `next_actor: kiro`. No
  merge/deploy/live write.

<!-- lane: wallet-subscriptions -->
## Lane `wallet-subscriptions` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports (2 ledger rows): `WALLET.SUBSCRIPTIONS /wallet/subscriptions`, `/profile/subscriptions`. depends_on: none. Web
sources `src/pages/wallet/Subscriptions.tsx` (143 lines, route `src/App.tsx:1568-1572`); `/profile/subscriptions` is
`ProfileSubscriptionsRouter` (`src/App.tsx:730-733`, `:1477-1482`) → on mobile `src/pages/MobileSubscriptions.tsx`
(105 lines), on desktop a redirect to `/wallet/subscriptions`. The native port mirrors the **mobile** branch
(`MobileSubscriptions` storefront) for `/profile/subscriptions` — today's behaviour.

- [ ] 1. Native subscriptions `apps/mobile/app/(app)/wallet/subscriptions.tsx` +
  `apps/mobile/src/screens/wallet-subscriptions/SubscriptionsScreen.tsx`: twin of the mobile-web branch of
  `Subscriptions.tsx`. **No `isIAPRestricted` import exists today → add no gate** (R3.2); subscriptions are flagged as
  digital content for the owner's decision-5 call (documentation only). Consume core / N2; no web import.
  Files: `apps/mobile/app/(app)/wallet/subscriptions.tsx`, `apps/mobile/src/screens/wallet-subscriptions/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 2. Native `/profile/subscriptions` `apps/mobile/app/(app)/profile/subscriptions.tsx` +
  `apps/mobile/src/screens/wallet-subscriptions/ProfileSubscriptionsScreen.tsx`: mirror
  `ProfileSubscriptionsRouter`'s mobile branch — render the `MobileSubscriptions` storefront twin (native is a mobile
  context, so the desktop redirect does not apply). **No gate added** (ungated today).
  Files: `apps/mobile/app/(app)/profile/subscriptions.tsx`, `apps/mobile/src/screens/wallet-subscriptions/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 3. i18n + RTL (as wallet-home task 4) for the two subscription screens.
  Files: `src/i18n/*/walletSubscriptionsNative.json` (DE first), `apps/mobile/src/screens/wallet-subscriptions/**`.
  Verify: `npm run typecheck`; `npm test` no-raw-text / no-physical-direction tests pass.
- [ ] 4. Unit tests (fake gateway / fixtures): subscriptions overview loaded/empty/error; the storefront renders;
  mobile router resolves `/profile/subscriptions` to the storefront (not the desktop redirect). React 19
  `ReactElement`.
  Files: `apps/mobile/tests/wallet-subscriptions/**`, `apps/mobile/src/screens/wallet-subscriptions/__tests__/**`.
  Verify: `npm test`; `APP_PROFILE=development npm run bundle`;
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 5. Flip the lane's 2 parity rows (`WALLET.SUBSCRIPTIONS`, `/profile/subscriptions`) to `native`; `--sync` then
  `--check`.
  Files: `apps/mobile/parity/ledger.json` (wallet-subscriptions rows only),
  `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 6. **(depends-on-owner / G1 — `next_actor: owner`)** Maestro `apps/mobile/maestro/wallet-subscriptions/*.yaml` +
  sim/emulator screenshots + parity vs 390×844 staging `/wallet/subscriptions` and `/profile/subscriptions`
  (read-only; no purchase attempted). Blocked until G1 (+ macOS/G3 for iOS).
  Files: `apps/mobile/maestro/wallet-subscriptions/**`, `docs/validation/<VTID>/staging-tests.json`.
- [ ] 7. PR: branch `kiro/native-wave2-wallet/wallet-subscriptions`, title
  `VTID-xxxxx (native-wave2-wallet/wallet-subscriptions): native subscriptions port (iOS IAP gates preserved)`;
  trailers `Collab-Session`, `Collab-Lane: native-wave2-wallet/wallet-subscriptions`; lane → `in-review`,
  `next_actor: kiro`. No merge/deploy/live write.

## Acceptance (every lane; the reviewer seat checks these)
- Requirements R1–R7 met for the lane's screens; mobile-web parity, N2/N3 composition, `@vitana/core`-only bridge;
  **every `isIAPRestricted` gate mirrored 1:1 — none added, removed, widened or narrowed** (R3).
- `npm run typecheck`, `npm test`, `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green; `node scripts/native/parity-ledger.mjs --check`
  green with the lane's rows `native`; `node scripts/native/core-closure.mjs --check` green.
- 11 locales, DE-first new keys (du-form; pt você-form), RTL covered; no hardcoded user-visible text; no physical
  `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** and **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (read-only) and `plan-sparring.md`.
- Device-runtime parity (the last task) is deferred to G1 as `next_actor: owner`; not a merge blocker for the port,
  it is recorded in the lane log and `staging-tests.json`.
- No new wallet route (NEVER rule 26); no `App.tsx` / registry / manifest change; the per-surface decision-5
  classification is recorded, not acted on.
- Never: VTID allocation, merge/approve, workflow dispatch, deploy, Supabase/AWS writes, or any test against
  production (protocol §7a; program §6).
