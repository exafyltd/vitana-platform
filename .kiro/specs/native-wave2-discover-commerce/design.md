# Design — Native Wave 2: Discover / Commerce / Cart / Orders screen ports (native-wave2-discover-commerce)
How the three lanes port the `discover-commerce` ledger cluster to native. Follows
`docs/programs/native-app/NATIVE-APP-PLAN.md` §3 (architecture) and §4 (parity method), the N3 shell and N2 UI kit
already on main, and `apps/mobile/README.md`. Nothing here changes the program plan or the design contract.

## 1. Where native screens live and how they resolve
Wave 1 N3 (VTID-05186) built the shell and a resolver route: `apps/mobile/app/(app)/[...path].tsx` renders every
ledger destination that is not yet native as "Unported", admin as the web console, unknown as not-found
(`apps/mobile/parity/ledger.json` `native_only` entry for `/*`). Porting a screen means **adding its own Expo Router
file under `apps/mobile/app/`** whose route path equals the web path, so the resolver no longer catches it, the push
`data.url` / universal link / ORB directive resolve the same, and the parity row can go `native`
(`scripts/native/parity-ledger.mjs` `fileToRoute()` maps `app/(app)/foo/[id].tsx` → `/foo/:id`).
Route-file plan (Expo Router, paths = web paths):
| Lane | Native route file(s) under `apps/mobile/app/` | Web path(s) |
|---|---|---|
| `discover` | `(app)/discover/index.tsx` (tabs `suggested`/`categories`/`share` via search param), `(app)/discover/supplements.tsx`, `(app)/discover/wellness-services.tsx`, `(app)/discover/deals-offers.tsx` (tabs `trending`/`ai`/`saved` via search param), `(app)/discover/category/[subcategory].tsx`, `(app)/shop.tsx` | `/discover`, `/discover?tab=…`, `/discover/supplements`, `/discover/wellness-services`, `/discover/deals-offers`, `/discover/deals-offers?tab=…`, `/discover/category/:subcategory`, `/shop` |
| `product-cart-checkout` | `(app)/discover/product/[id].tsx`, `(app)/universal-cart.tsx`, `(app)/checkout/success.tsx`, `(app)/tickets/success.tsx`, `(app)/packages/success.tsx` | `/discover/product/:id`, `/universal-cart`, `/checkout/success`, `/tickets/success`, `/packages/success` |
| `marketplace-orders` | `(app)/discover/marketplace.tsx` (`?view=mine\|open`), `(app)/discover/doctors-coaches.tsx`, `(app)/discover/provider/[id].tsx`, `(app)/discover/orders.tsx` (`?tab=active\|history`), `(app)/my-tickets.tsx` | the R0.4 paths |
Query-string variants (`?tab=`, `?view=`) are the **same route file** reading the search param, exactly as the web
screen reads `useSearchParams()` — they are distinct ledger rows but not distinct files, so they do not overlap across
lanes. The ledger's shape-matching (`shapeOf`, query dropped) is satisfied by the single file. The `discover` lane's
own route files are exactly `discover/index.tsx`, the three sub-catalogues (`supplements.tsx`, `wellness-services.tsx`,
`deals-offers.tsx`), `discover/category/[subcategory].tsx` and `shop.tsx` — it creates no other file under
`app/(app)/discover/`, so although its `paths` glob `app/(app)/discover/**` textually overlaps the sibling leaves the
other two lanes own (`product/**`, `marketplace.tsx`, `orders.tsx`, `provider/**`, `doctors-coaches.tsx`), the
PR-GATE **Lane scope** check keys on the files each PR actually changes and the lanes stay disjoint in practice (see
§3, glob note).

## 2. Screen source: the N2/N3 structure, not the web DOM
Each lane re-implements the **mobile web** branch of its source screen with React Native primitives:
- Imports go through ports only: `@vitana/core/*` (pure hooks, query keys, types, pure mappers), `@vitana/ui` (UI
  kit), `@vitana/tokens` (visual values), `src/ports/*` from the shell (`core`, `ui`, `links`, `badges`, `soundscape`,
  `orb-slot`). No `@/…` web import (ESLint-banned in app code).
- The web→native prop map (`apps/mobile/README.md`) is mechanical: `onClick`→`onPress`, `className`→`style`, shadcn
  `Card`→`VCard`/`Panel`, `Dialog`/`Sheet`/`ResponsiveDialog`→the kit's modal / bottom sheet,
  `toast`/`notify*`→`@vitana/ui`/`@vitana/ui/sonner`, list/scroll→`FlatList`/`ScrollView`, `<video>`→`expo-video`,
  `<img>`→`expo-image`.
- Data-fetching hooks are class-B (they runtime-import `src/integrations/supabase/client.ts`, `import.meta.env`,
  `localStorage`): `useMarketplaceFeed` / `useMarketplaceSearch` / `useMarketplaceProduct`, `useShopFeed` /
  `useShopVideoAnchor` / `useShopEvents`, `useUniversalCart`, `useShoppingAgent`, `useDeposit`, the wallet gateway
  client, `getIntentBoard`, `useMyTickets` / `useMyVouchers` and the `cj_orders` Supabase read. They are
  **re-implemented natively** (native Supabase client + native auth context), exactly as the home-feed lane did — never
  moved into core.

### 2a. Archetypes (Spotlight contract)
`/shop` is the one **immersive** archetype in the cluster (full-screen vertical-snap video feed; anchor pill → peek
drawer → PDP drawer; autoplay/pause). Everything else is `storefront` / `collection` (the discover overview and
sub-catalogue grids, the marketplace intents board, the orders lists), `detail` (product detail, provider profile,
the success-confirmation screens) or `form`-shaped (the cart quantity steppers + checkout). Each archetype maps to the
program's per-type functional-parity checklist (§4).

### 2b. discover lane specifics (owns the shared controls + the core extraction)
`/discover` is the `MobileDiscoverView` (`src/components/discover/MobileDiscoverView.tsx`) + `MobileModePill` branch
(suggested / categories / share pills, `allowGuest`, guest CTA → sign-in). The sub-catalogues (supplements, wellness,
deals-offers with its four tabs) are `allowGuest` product/search grids, each hosting multiple `AddToCartButton`s.
`/shop` is the immersive feed. The **shared purchase control `AddToCartButton`** (`src/components/cart/AddToCartButton.tsx`)
is ported once here as a native twin (gates on `useAuth`, role-blocks via `useUniversalCart`, only `product`-typed UUID
items), exported via a port so `product-cart-checkout` consumes it without re-owning the file. The `MobileDiscoverView`
twin is owned here too. This is the lane that owns **the core extraction**: the genuinely pure / class-A helpers the
discover feed/search/cards and the shop feed need (e.g. price/format mappers, `discover-reason`, the shop-feed pure
mappers) are added to `packages/core/manifest.json` with a re-export, `node scripts/native/core-closure.mjs --write`
is run, and the regenerated `packages/core/closure.generated.json` + `scripts/native/mobile-ci-paths.generated.json`
are committed in the same PR (program §3 extraction model: one module per PR, independent revert). The executor
confirms each candidate is IO-free before adding a manifest entry; `core-closure --check` fails the build on a
class-B mis-classification, so a mistake fails CI rather than ships.

### 2c. product-cart-checkout lane specifics (the purchase core, every highest-priority IAP flag)
`ProductDetail` (`src/pages/discover/ProductDetail.tsx`) is a **public** PDP with `AddToCartButton` (consumed via the
`discover` port) + an affiliate "Buy" external redirect (`getRedirectUrl`) + reward-points preview. `UniversalCart`
(`src/pages/UniversalCart.tsx`) is the gated primary flow: Warenkorb / Gemerkt tabs, quantity steppers, the wallet
balance card (`GatewayWalletBalanceCard`), **checkout with idempotency**, AI propose/reorder (`useShoppingAgent`), the
`AddMoneyDialog` on insufficient balance, and affiliate redirects. The three success screens are leaves:
`/checkout/success` refreshes the cart on `?checkout_id` and polls Stripe wallet top-up status on `?deposit_id`
(`useDeposit`); `/tickets/success` and `/packages/success` are post-purchase confirmations. This lane carries every
highest-priority iOS-IAP-gate flag (R5.3): the cart checkout, the `AddMoneyDialog` wallet top-up, and the
`?deposit_id` deposit-return — each flagged per screen, **behaviour unchanged**. Core extraction here is optional and
only for genuinely pure checkout/money helpers (`checkout-idempotency`, `format-money`); the cart/checkout/wallet
gateway hooks stay native (class-B). The lane `depends_on: [discover]` because it consumes the `AddToCartButton` twin.

### 2d. marketplace-orders lane specifics (no purchase control)
`Marketplace` (`src/pages/discover/Marketplace.tsx`) is the commercial-intent board (`getIntentBoard`,
commercial_buy + commercial_sell + affiliate) with the `useIsMobile` compact utility bar and the mine/open view
filters — no direct cart. `DoctorsCoaches` is a gated provider directory; `ProviderProfile` a provider detail (booking
is out of cluster). `/discover/orders` is the `MobileOrdersView` (`src/components/orders/MobileOrdersView.tsx`) branch
(active / history tabs, unified tickets / CJ orders / vouchers, reads `supabase.from('cj_orders')`, `useMyTickets`,
`useMyVouchers`); `/my-tickets` is the purchased-tickets list. No add-to-cart / checkout control anywhere, so **no
IAP-gate flag applies to any of this lane's 9 rows.** The `MobileOrdersView` twin is owned here. The member-listing /
orders queries are reused unchanged from the web hooks, so any test/service allowlist exclusion already lives in the
query logic (program NEVER rule 45 is satisfied by reuse, not re-implementation; the lane states this in its PR).

## 3. Disjointness (no overlap, no orphan)
- **Ledger rows:** the 26 `discover-commerce` rows partition cleanly — `discover` 12 (11 registry + `/discover/category/:subcategory`),
  `product-cart-checkout` 5 (2 registry + `/checkout/success`, `/tickets/success`, `/packages/success`),
  `marketplace-orders` 9 (all registry). 12 + 5 + 9 = 26 (registry 11 + 2 + 9 = 22; exclusion 1 + 3 + 0 = 4). Each row
  named explicitly in the lane file and in `requirements.md` R0.2–R0.4.
- **Native files:** each lane owns a disjoint subtree of `apps/mobile/app/` and `apps/mobile/src/screens/` (one folder
  per lane: `src/screens/discover/`, `src/screens/commerce/`, `src/screens/marketplace-orders/`). No file is in two
  lanes.
- **Glob note (NIT from review, recorded):** `discover`'s recursive `app/(app)/discover/**` glob textually also matches
  the files the other two lanes own under `app/(app)/discover/` (`product/**`, `marketplace.tsx`, `orders.tsx`,
  `provider/**`, `doctors-coaches.tsx`). To make Lane scope reject a cross-lane edit by construction rather than by
  convention, each lane's `paths` enumerates its own leaves under `app/(app)/discover/` instead of a bare recursive
  glob — see §1 and the lane files. The row/screen-subtree partition is disjoint either way.
- **Tests:** each lane owns `apps/mobile/tests/discover-commerce/<its spec files>`,
  `apps/mobile/maestro/discover-commerce/<its journeys>` and its `docs/validation/<VTID>/` folder.
- **Shared, by-row-not-by-file:** `apps/mobile/parity/ledger.json` (each lane edits only its own rows),
  `packages/core/manifest.json` + `packages/core/src/**` closure (each lane adds only the re-exports it needs; the
  generated `closure.generated.json` + `mobile-ci-paths.generated.json` churn belongs to the lane that added the
  module), `apps/mobile/src/ports/**` + `apps/mobile/src/navigation/resolve.ts` (each lane adds only its own port /
  resolver entries), and the DE-first i18n shard `src/i18n/*/discoverCommerceNative.json` (each lane adds only its
  screens' keys). These are listed in each lane's `paths`; conflicts resolve by row / key.

## 4. Decisions (made by Kiro as planner; sparring may revise)
1. **Three lanes, not one.** The cluster is 26 rows over three natural, non-overlapping route/screen subtrees:
   `discover` (overview + tabs + sub-catalogues + the `/shop` immersive feed), `product-cart-checkout` (product detail
   + the full purchase/confirmation flow), `marketplace-orders` (commercial-intent marketplace + provider directory +
   orders/tickets). Rationale: the three touch disjoint route files and components, build and review independently, and
   each leaves the app buildable; matches the model's own 3-lane shape and the owner's "multiple agents in parallel"
   directive. Reason recorded here per planning-mode rule.
2. **Only pure / class-A helpers move into `@vitana/core`; data-fetching hooks are re-implemented natively.** The
   discover feed/search/cards, cart/checkout and intents/orders all run through hooks that runtime-import
   `src/integrations/supabase/client.ts` (class-B: `import.meta.env`, `localStorage`, the prod Supabase URL), so they
   fail the `core-closure.mjs` class-A gate and are re-implemented natively, exactly as the home-feed lane did. Never
   move a class-B module into core; only genuinely IO-free helpers (price/format mappers, `discover-reason`, shop-feed
   pure mappers, `checkout-idempotency`, `format-money`) get a core re-export.
3. **The `discover` lane owns the `AddToCartButton` + `MobileDiscoverView` native twins**, shared into
   `product-cart-checkout` via a port, so each twin has exactly one owner and the two lanes' `paths` stay disjoint.
   `product-cart-checkout` `depends_on: [discover]` for this reason; `discover` and `marketplace-orders` have no deps
   and run in parallel. `marketplace-orders` owns the `MobileOrdersView` twin.
4. **No new routes / registry / manifest.** These are ports of screens that already exist in `App.tsx` and
   `screens.json`; adding a native route file is not an `App.tsx` route, so the "new page needs
   screens.json/exclusions.json + screen-manifest + parity rows" rule does not fire — only parity-row **status** flips.
   The lane adds a native route file and a status flip, nothing in `src/navigation/registry/`.
5. **iOS IAP gate flagged per screen, behaviour unchanged.** `isIAPRestricted()` today = `Platform.OS === 'ios'`
   (`apps/mobile/src/shell/logic/drawer.ts:37-38`). Every purchase surface carries an explicit per-screen flag
   (`requirements.md` R5, the table in §5.2) recording today's behaviour; the gate extension (program decision 5) is
   deferred to an iOS store submission and NOT decided in this parity port. The port must NOT silently add or remove
   any iOS gating.
6. **Runtime verification is deferred to G1** (owner gate). Lanes land the ports with offline build + fake-gateway
   unit tests green; the simulator/Maestro/screenshot-parity pass is a `next_actor: owner` task recorded in the lane
   and the `staging-tests.json`. This matches the program's "fixture / fake-gateway tests only until G1" model.
7. **Mobile-web parity, not desktop.** Each native screen mirrors the `useIsMobile()` ≤ 1024 px branch of its source —
   `MobileDiscoverView` for `/discover`, `MobileOrdersView` for `/discover/orders`, the immersive `/shop` — composed
   through N3/N2, every visual value from `@vitana/tokens`; no web file is touched beyond a DE-first i18n key and a
   `@vitana/core` re-export line.

## 5. Test design (per lane)
- **Unit (jest-expo + RNTL, fake gateway):** each screen renders its loaded state from fixture data, its empty state,
  its error state. discover: the `MobileDiscoverView` mode-pill tabs switch, the add-to-cart gate states (signed-out →
  sign-in, role-block, product-only), the `/shop` video autoplay/pause mapping. product-cart-checkout: product-detail,
  cart quantity steppers, checkout idempotency preserved, the `AddMoneyDialog` on insufficient balance, the three
  success screens (`?checkout_id` cart refresh, `?deposit_id` deposit poll). marketplace-orders: the intents board
  (buy/sell/affiliate), provider profile, orders active/history tabs, my-tickets. Pure-module tests for any core module
  a lane adds. No network — the gateway/core hooks are mocked with fixtures.
- **i18n/RTL:** a test asserts no hardcoded user-visible string in the lane's screens and no physical `left`/`right`;
  renders one screen under `ar` (RTL) and asserts start/end classes. New keys DE-first in
  `src/i18n/de/discoverCommerceNative.json`, mirrored to the other ten.
- **Typecheck/bundle/deps:** `npm run typecheck`, `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` from `apps/mobile/`.
- **Parity + core closure:** `node scripts/native/parity-ledger.mjs --check` (rows `native`, routes present) and, for a
  core-extracting lane, `node scripts/native/core-closure.mjs --check` with the regenerated
  `closure.generated.json` + `mobile-ci-paths.generated.json` committed in-PR, from the repo root.
- **Deferred (G1, `next_actor: owner`):** Maestro journeys `maestro/discover-commerce/*.yaml`, iOS simulator + Android
  emulator screenshots at the device sizes, screenshot parity vs the 390×844 read-only staging web screen, listed in
  `docs/validation/<VTID>/staging-tests.json`.

## 6. Open items for the owner / sparring
- G1 isolated test environment (program gate) is required before any device-runtime parity check; until then the
  deferred tasks stay `next_actor: owner`.
- The iOS-IAP-gate extension for digital purchase surfaces (program decision 5) — owner/store decision, deferred; this
  port only flags the surfaces and keeps today's behaviour.
- macOS minutes / G3 for iOS-on-device screenshots (program STATUS row 8b) — not needed for the JS build.
- Whether the shared i18n shard stays single (`discoverCommerceNative.json`) or splits per lane
  (`discoverNative.json` / `cartOrdersNative.json` / `marketplaceOrdersNative.json`); default mirrors the model's
  single-shard-per-spec pattern.
