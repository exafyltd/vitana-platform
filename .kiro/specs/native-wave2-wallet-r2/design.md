# Design — Native Wave 2: Wallet screen ports (native-wave2-wallet-r2)

How the three lanes port the `wallet` ledger cluster to native. Follows
`docs/programs/native-app/NATIVE-APP-PLAN.md` §3 (architecture) and §4 (parity method), the N3 shell and N2 UI kit
already on main, and `apps/mobile/README.md`. Nothing here changes the program plan or the design contract. The
wallet-specific constraints — **no new wallet route** (NEVER rule 26, program §3 Wallet line) and **iOS-IAP gating
preserved 1:1** (decision 5) — are recorded as decisions 2 and 4 below.

## 1. Where native screens live and how they resolve

Wave 1 N3 (VTID-05186) built the shell and a resolver route: `apps/mobile/app/(app)/[...path].tsx` renders every
ledger destination that is not yet native as "Unported", admin as the web console, unknown as not-found
(`apps/mobile/parity/ledger.json` `native_only` entry for `/*`). Porting a screen means **adding its own Expo Router
file under `apps/mobile/app/`** whose route path equals the web path, so the resolver no longer catches it, the push
`data.url` / universal link / ORB directive resolve the same, and the parity row can go `native`
(`scripts/native/parity-ledger.mjs` `fileToRoute()` maps `app/(app)/foo/[id].tsx` → `/foo/:id`). **No route path is
added that does not already exist on the web** (NEVER rule 26) — every native route file below maps to an existing
`App.tsx` route verified on `origin/main`.

Route-file plan (Expo Router, paths = existing web paths):

| Lane | Native route file(s) under `apps/mobile/app/` | Existing web path(s) |
|---|---|---|
| `wallet-home` | `(app)/wallet/index.tsx` (tabs `actions`/`activity` via search param; the `WalletPopup` overlay rendered by the screen), `(app)/wallet/balance.tsx` (tabs `membership`/`optimization`/`tokens` via search param) | `/wallet`, `/wallet?tab=actions`, `/wallet?tab=activity`, `/wallet/balance`, `/wallet/balance?tab=…` |
| `wallet-rewards` | `(app)/wallet/rewards.tsx` (tabs `earn`/`shop` via search param), `(app)/redeem.tsx` | `/wallet/rewards`, `/wallet/rewards?tab=…`, `/redeem` |
| `wallet-subscriptions` | `(app)/wallet/subscriptions.tsx`, `(app)/profile/subscriptions.tsx` (mobile branch = the `MobileSubscriptions` storefront) | `/wallet/subscriptions`, `/profile/subscriptions` |

Query-string variants (`?tab=…`) are the **same route file** reading the search param, exactly as the web screen
reads `useUrlTab()` / `useSearchParams()` — they are distinct ledger rows but not distinct files, so they do not
overlap across lanes. The ledger's shape-matching (`shapeOf`, query dropped) is satisfied by the single file, so a
tab row is covered by its base route file; each lane flips **every** one of its rows to `native`, not only the base
rows (R5.1).

`OVERLAY.WALLET_POPUP /wallet` is the global `WalletPopup` overlay (program §3 global-overlays list:
`AutopilotPopup`, `WalletPopup`, …). It shares the `/wallet` shape, is owned by the `wallet-home` lane, and is
rendered by the native wallet screen's overlay slot — not a separate route file. The lane flips its row alongside
`WALLET.OVERVIEW`.

## 2. Screen source: the N2/N3 structure, not the web DOM

Each lane re-implements the **mobile web** branch of its source screen with React Native primitives:

- Imports go through ports only: `@vitana/core/*` (pure helpers, query keys, types), `@vitana/ui` (UI kit),
  `@vitana/tokens` (visual values), `src/ports/*` from the shell (`core`, `ui`, `links`, `badges`, `orb-slot`). No
  `@/…` web import (ESLint-banned in app code).
- The web→native prop map (`apps/mobile/README.md`) is mechanical: `onClick`→`onPress`, `className`→`style`,
  shadcn `Card`→`VCard`/`Panel`, `Dialog`/`Sheet`/`ResponsiveDialog`→the kit's modal / bottom sheet,
  `toast`/`notify*`→`@vitana/ui`/`@vitana/ui/sonner`, list/scroll→`FlatList`/`ScrollView`.
- Mobile patterns already in the shell are reused: `MobileModePill`, bottom sheets for the wallet popups
  (`AddFundsPopup`, `BuyCreditsPopup`, `WithdrawPopup`, `SpendCreditsPopup`), the mobile quick-actions row
  (`src/components/wallet/mobile/MobileWalletQuickActions.tsx`).

### 2a. `wallet-home` lane specifics (the hub)

`src/pages/Wallet.tsx` (970 lines) is the wallet hub: the master-action popup (`WalletMasterActionPopup`), quick
actions, balance summary, activity list, the add-funds / buy-credits / withdraw / spend flows, and the
quick-exchange widget. The native Home renders the same sections through N2 `VCard`s; the popups become native bottom
sheets. **Every `isIAPRestricted()` branch in the web source is mirrored one-for-one** (§4 decision 4 / R3): on iOS
the add-funds / buy / withdraw / deposit primary actions and the quick-exchange widget are hidden exactly as the web
hides them; the balance summary and activity list stay visible. `src/pages/wallet/Balance.tsx` (491 lines) is the
balance detail with the `membership` / `optimization` / `tokens` tabs (`useUrlTab`): the `if (isIAPRestricted())
return null` on the optimization top-up affordance and the gated `spotlightAction` are preserved. Currency conversion
(`convertFromUsd`, `getCurrencySymbol`, `src/lib/exchangeRates.ts`) is **pure (class-A)** and consumed from
`@vitana/core` (decision 3); the balance/activity data fetch (`useWallet`, `useWalletGateway`, `useDisplayCurrency`,
`useEurUsdRate`) is class-B (Supabase/gateway) and re-implemented natively (§3 extraction model).

### 2b. `wallet-rewards` lane specifics

`src/pages/wallet/Rewards.tsx` (137 lines) is the rewards screen with `earn` / `shop` tabs (`useUrlTab`); the shop
purchase affordance is `isIAPRestricted`-branched on iOS and the native twin preserves that branch exactly (R3.2).
`src/pages/RedeemVoucher.tsx` (206 lines, route `/redeem`) is voucher code redemption via `useVoucherByCode` /
`useClaimVoucher` — a code-claim, not a purchase, so **ungated** (no IAP concern); the native twin mirrors it
unchanged. Both are leaf screens.

### 2c. `wallet-subscriptions` lane specifics

`src/pages/wallet/Subscriptions.tsx` (143 lines, `/wallet/subscriptions`) is the subscriptions overview;
`/profile/subscriptions` is `ProfileSubscriptionsRouter` (`src/App.tsx:730-733, 1477-1482`) which on mobile renders
`src/pages/MobileSubscriptions.tsx` (105 lines) and on desktop redirects to `/wallet/subscriptions`. The native port
mirrors the **mobile** branch for `/profile/subscriptions` (the `MobileSubscriptions` storefront) — today's behaviour,
not a change. Neither page imports `isIAPRestricted` today, so the native twins **add no gate** (R3.2); subscriptions
are flagged as digital content for the owner's decision-5 call, documentation only.

## 3. Core extraction (class-A vs class-B) — verified on `origin/main`

The parity method's rule: only pure IO-free (class-A) modules enter `@vitana/core`; any module importing
`@/integrations/supabase/client` or `@/lib/community-gateway` (or reading browser globals) is class-B and
re-implemented natively (program §3; R4).

| Module | Class | Why | Native handling |
|---|---|---|---|
| `src/lib/exchangeRates.ts` (117 lines) | **A** | No imports, no IO — pure currency math (`convertFromUsd`, `getCurrencySymbol`) | **`@vitana/core` re-export** (owned by `wallet-home`) |
| `src/lib/appilix.ts` (`isIAPRestricted`/`isIOSApp`) | **B** | Reads `window`/`navigator`/`window.appilix` browser globals | Native platform-detection equivalent (shell); gate decision applied per surface |
| `src/hooks/useWallet`, `useWalletGateway`, `useDisplayCurrency`, `useEurUsdRate`, `useRedeemVoucher` | **B** | Runtime-import the Supabase client / gateway | Re-implemented natively (native Supabase client + native auth context) |
| Wallet page components (`Wallet.tsx`, `Balance.tsx`, `Rewards.tsx`, `Subscriptions.tsx`, `RedeemVoucher.tsx`, `MobileSubscriptions.tsx`) | **B** | DOM-coupled React screen components | Re-implemented as native screens on N2/N3 |

The `wallet-home` lane PR adds `packages/core/src/exchangeRates.ts` (the re-export entry) + the matching
`packages/core/manifest.json` line, and **in the same PR** runs `node scripts/native/core-closure.mjs --write` and
commits the regenerated `packages/core/closure.generated.json` and `scripts/native/mobile-ci-paths.generated.json`,
so `--check` passes. `wallet-rewards` and `wallet-subscriptions` consume core but add no core entry — this keeps the
"same PR as the re-export" governance rule owned by exactly one lane, so a reviewer of the `wallet-home` PR knows to
check for the generated-file commits.

## 4. Decisions (made by Kiro as planner; sparring may revise)

1. **Three lanes, split by page-file cluster, not one.** Disjoint by native route file and web page: `wallet-home`
   (`Wallet.tsx` + `Balance.tsx` — the hub + balance, 8 rows), `wallet-rewards` (`Rewards.tsx` + `RedeemVoucher.tsx` —
   rewards + redeem, 4 rows), `wallet-subscriptions` (`Subscriptions.tsx` + `MobileSubscriptions.tsx` — subscriptions,
   2 rows). The three touch disjoint route files and component folders, build/review independently, each leaves the
   app buildable. 8 + 4 + 2 = 14, the exact `wallet`-lane row count.
2. **No new wallet route (NEVER rule 26; program §3 Wallet line).** Every native route file maps to an existing
   `App.tsx` route (verified `origin/main`: `/wallet`, `/wallet/balance`, `/wallet/rewards`, `/wallet/subscriptions`,
   `/redeem`, `/profile/subscriptions`). Adding a native Expo Router file is not an `App.tsx` route, so the "new page
   needs screens.json/exclusions.json + screen-manifest + parity rows" rule does not fire — only parity-row **status**
   flips (`not_started`→`in_progress`→`native`). The lane adds no `src/navigation/registry/` entry and no new route
   path.
3. **Only the pure `exchangeRates` helper moves into `@vitana/core`; the data hooks and screen components do NOT**
   (R4). `exchangeRates.ts` is IO-free (class-A); the wallet data hooks runtime-import the Supabase client (class-B)
   and would fail `core-closure --check`, so they are re-implemented natively. Owned by `wallet-home`, with
   `core-closure.mjs --write` run and the generated files committed in the same PR.
4. **iOS-IAP gating preserved 1:1 — parity port, not a gating change (decision 5 / R3).** Each surface's current
   `isIAPRestricted()` branches are mirrored one-for-one; no gate is added, removed, widened or narrowed. The
   per-surface classification (physical/real-world service = external payment allowed; digital content = StoreKit IAP
   or hidden on iOS) is **recorded for the owner**, not acted on. The final iOS payment decision (whether StoreKit /
   Play Billing is introduced) is an owner gate (`next_actor: owner`), not made in this plan. The 21-file
   `isIAPRestricted`/`isIOSApp` reference set on `origin/main`: `src/lib/appilix.ts`, `src/components/AppLayout.tsx`,
   `src/components/mobile/SideDrawerNav.tsx` (+ its `.health-orders-nav.test.ts`),
   `src/components/payment/ExchangeAndSendPopup.tsx`, `src/components/ui/utility-action-button.tsx`,
   `src/components/wallet/ExchangeRateDisplay.tsx`, `src/components/wallet/QuickExchangeWidget.tsx`,
   `src/components/wallet/VtnaRewardRules.test.tsx`, `src/components/wallet/WalletMasterActionPopup.tsx`,
   `src/components/wallet/mobile/MobileWalletQuickActions.tsx`, `src/components/wallet/popups/{AddFundsPopup,
   BuyCreditsPopup,SpendCreditsPopup,WithdrawPopup}.tsx`, `src/components/wallet/steps/{ExchangeAndSendStep,
   ExchangeStep}.tsx`, `src/pages/Wallet.tsx`, `src/pages/wallet/Balance.tsx`, `src/pages/wallet/Rewards.tsx`,
   `src/pages/wallet/mobile-wallet-rewards.test.tsx`.
5. **Runtime verification is deferred to G1** (owner gate). Lanes land the ports with offline build + fake-gateway
   unit tests green; the simulator/Maestro/screenshot-parity pass is a `next_actor: owner` task recorded in the lane
   and the `staging-tests.json`. This matches the program's "fixture / fake-gateway tests only until G1" model
   (`.kiro/specs/health-native` handoff, `native-g1-wiring`).

## 5. Disjointness (no overlap, no orphan)

- **Ledger rows:** the 14 `wallet` rows partition cleanly — `wallet-home` 8 (`WALLET.OVERVIEW`, `OVERLAY.WALLET_POPUP`,
  `WALLET.ACTIONS`, `WALLET.ACTIVITY`, `WALLET.BALANCE`, `WALLET.BALANCE_MEMBERSHIP`, `WALLET.BALANCE_OPTIMIZATION`,
  `WALLET.BALANCE_TOKENS`), `wallet-rewards` 4 (`WALLET.REWARDS`, `WALLET.REWARDS_EARN_MORE`, `WALLET.REWARDS_SHOP`,
  `/redeem`), `wallet-subscriptions` 2 (`WALLET.SUBSCRIPTIONS`, `/profile/subscriptions`). 8 + 4 + 2 = 14. Each row
  named explicitly in the lane file.
- **Native files:** each lane owns a disjoint subtree of `apps/mobile/app/` and `apps/mobile/src/screens/` (one
  folder per lane: `src/screens/wallet-home/`, `src/screens/wallet-rewards/`, `src/screens/wallet-subscriptions/`). No
  file is in two lanes. (The `/wallet/*` route files are split by cluster: `wallet/index.tsx` + `wallet/balance.tsx`
  in `wallet-home`, `wallet/rewards.tsx` in `wallet-rewards`, `wallet/subscriptions.tsx` in `wallet-subscriptions` —
  distinct files under `app/(app)/wallet/`, no overlap.)
- **Tests:** each lane owns `apps/mobile/tests/<its screen test files>` and its `docs/validation/<VTID>/` folder.
- **Shared, by-row-not-by-file:** `apps/mobile/parity/ledger.json` (each lane edits only its own rows),
  `packages/core/manifest.json` + `packages/core/src/**` closure (only `wallet-home` adds a re-export), and the
  DE-first i18n shards (each lane adds only its screens' keys). These are listed in each lane's `paths`.

## 6. Test design (per lane)

- **Unit (jest-expo + RNTL, fake gateway):** each screen renders its loaded state from fixture data, its empty state,
  its error state. Wallet-home: the balance/activity sections render from fixtures; **the `isIAPRestricted` gate is
  tested both ways** — iOS-gated fixture hides the add-funds/buy/withdraw actions and the quick-exchange widget,
  non-iOS fixture shows them (parity assertion, the single most important wallet test). Rewards: earn/shop tab switch,
  shop gated on iOS; redeem: code valid / invalid / claimed. Subscriptions: overview renders; mobile router resolves
  to the storefront. `exchangeRates` pure-module unit tests (`convertFromUsd`, `getCurrencySymbol`).
- **i18n/RTL:** a test asserts no hardcoded user-visible string in the lane's screens and no physical `left`/`right`;
  renders one screen under `ar` (RTL) and asserts start/end.
- **Typecheck/bundle/deps:** `npm run typecheck`, `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` from `apps/mobile/`.
- **Parity + core:** `node scripts/native/parity-ledger.mjs --check` and `node scripts/native/core-closure.mjs
  --check` from the repo root (rows `native`, routes present, generated files fresh).
- **Deferred (G1, `next_actor: owner`):** Maestro journeys `apps/mobile/maestro/<lane>/*.yaml`, iOS simulator +
  Android emulator screenshots at the device sizes, screenshot parity vs the 390×844 read-only staging web screen,
  listed in `docs/validation/<VTID>/staging-tests.json`.

## 7. Open items for the owner / sparring

- **Decision 5 (iOS payment classification)** — the per-surface classifications in R3.2 are recorded for the owner;
  whether StoreKit / Google Play Billing is introduced for any digital-content surface is an owner call, not made
  here. Until decided, the port keeps today's behaviour (the existing `isIAPRestricted` gates, unchanged).
- G1 isolated test environment (program gate) — required before any device-runtime parity check; the deferred tasks
  stay `next_actor: owner` until it exists.
- macOS minutes / G3 for iOS-on-device screenshots (program STATUS row 8b) — not needed for the JS build.
