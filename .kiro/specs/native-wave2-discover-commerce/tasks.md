# Tasks — Native Wave 2: Discover / Commerce / Cart / Orders screen ports
Three lanes, disjoint `paths`. Design: `design.md` and `requirements.md` in this folder are authoritative — follow
them exactly; anything outside them is a plan change (log it, set `next_actor: claude`). VTIDs are assigned by CI
after PLAN-SPAR converges; do not start a lane before its `vtid:` is set in `lanes/<id>.md`. All commands run from
`apps/mobile/` unless noted; `assertNotProduction()` and the no-production-profile rule make every command offline.
This is a parity port: mirror the mobile-web behaviour exactly, add no onboarding step/field/dialog/friction, and
keep every purchase surface's iOS behaviour unchanged (only flag it for the `isIAPRestricted` gate, decision deferred).
<!-- lane: discover -->
## Lane `discover` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports (12 ledger rows under `"lane": "discover-commerce"`): `DISCOVER.OVERVIEW /discover`,
`DISCOVER.AI_PICKS /discover?tab=suggested`, `DISCOVER.CATEGORIES /discover?tab=categories`,
`DISCOVER.SHARE_EARN /discover?tab=share`, `DISCOVER.SHOP /shop`, `DISCOVER.SUPPLEMENTS /discover/supplements`,
`DISCOVER.WELLNESS_SERVICES /discover/wellness-services`, `DISCOVER.DEALS /discover/deals-offers`,
`DISCOVER.DEALS_TRENDING /discover/deals-offers?tab=trending`, `DISCOVER.DEALS_AI /discover/deals-offers?tab=ai`,
`DISCOVER.DEALS_SAVED /discover/deals-offers?tab=saved`, and the exclusion row
`/discover/category/:subcategory`. depends_on: none. **Owns the shared `AddToCartButton` + `MobileDiscoverView`
native twins and the core extraction.** Web sources `src/pages/Discover.tsx` (`MobileDiscoverView` + `MobileModePill`
branch), `src/pages/ShopFeed.tsx` (immersive vertical-snap video feed), `src/pages/discover/Supplements.tsx`,
`WellnessServices.tsx`, `DealsOffers.tsx`, `CategoryProducts.tsx`; shared control
`src/components/cart/AddToCartButton.tsx`, `src/components/discover/MobileDiscoverView.tsx`.
- [ ] 1. Core re-exports: add the pure / class-A discover and shop helpers (marketplace price/format mappers,
  `discover-reason`, shop-feed pure mappers — only genuinely IO-free ones; a DOM/Supabase-coupled module stays native,
  never moved into core) to `@vitana/core` via the manifest, then `node scripts/native/core-closure.mjs --write`. The
  data-fetching hooks (`useMarketplaceFeed`/`useMarketplaceSearch`/`useShopFeed`) runtime-import
  `src/integrations/supabase/client.ts` (class B) and are re-implemented natively, not re-exported.
  Files: `packages/core/manifest.json`, `packages/core/src/**`, `packages/core/closure.generated.json`,
  `scripts/native/mobile-ci-paths.generated.json`.
  Verify (repo root): `node scripts/native/core-closure.mjs --check` passes; `apps/mobile` → `npm run typecheck` green.
- [ ] 2. Shared native `AddToCartButton` twin + `MobileDiscoverView` twin, each exported via a port
  (`apps/mobile/src/ports/**`) so `product-cart-checkout` consumes `AddToCartButton` without owning it. The twin
  mirrors `src/components/cart/AddToCartButton.tsx`: gates on native auth (signed-out → sign-in), role-blocks via the
  native cart, only `product`-typed UUID items enter the cart; **behaviour unchanged**. Flag the add-to-cart control
  as a purchase surface (iOS `isIAPRestricted` gate, today's behaviour, decision deferred).
  Files: `apps/mobile/src/screens/discover/**`, `apps/mobile/src/ports/**`.
  Verify: `npm test` (add-to-cart gate states) + `npm run typecheck` green.
- [ ] 3. Discover overview + tabs + `/shop`: `apps/mobile/app/(app)/discover/index.tsx` renders the
  `MobileDiscoverView` twin with the `MobileModePill` (suggested / categories / share via the `tab` search param,
  `allowGuest` with the guest sign-in CTA); `apps/mobile/app/(app)/shop.tsx` the immersive full-screen vertical-snap
  video feed (anchor pill → peek drawer → PDP drawer, autoplay/pause, `<video>`→`expo-video`). Mobile-web branch only.
  Files: `apps/mobile/app/(app)/discover/index.tsx`, `apps/mobile/app/(app)/shop.tsx`,
  `apps/mobile/src/screens/discover/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 4. Discover sub-catalogues: supplements, wellness-services, deals-offers (with the `trending`/`ai`/`saved`
  tabs via `tab`), and the `/discover/category/:subcategory` grid. Each `allowGuest` product grid hosts the
  `AddToCartButton` twin. Flag every add-to-cart surface (iOS gate, today's behaviour).
  Files: `apps/mobile/app/(app)/discover/supplements.tsx`, `.../discover/wellness-services.tsx`,
  `.../discover/deals-offers.tsx`, `.../discover/category/[subcategory].tsx`, `apps/mobile/src/screens/discover/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 5. i18n + RTL: user-visible strings from the web shards; any genuinely new key added to
  `src/i18n/de/discoverCommerceNative.json` first, then the other ten (ar de en es fr pl pt ru sr tr zh); render under
  `ar` with start/end only; no hardcoded text, no physical `left`/`right`.
  Files: `src/i18n/*/discoverCommerceNative.json` (DE first), `apps/mobile/src/screens/discover/**`.
  Verify: `npm run typecheck`; `npm test` — the no-raw-text and no-physical-direction tests pass.
- [ ] 6. Unit tests (fake gateway / fixtures, no network): discover loaded / empty / error; mode-pill tab switch;
  add-to-cart signed-out → sign-in gate and role-block; `/shop` video autoplay/pause + anchor→PDP mapping; each
  sub-catalogue load + add-to-cart; `/discover/category/:subcategory` grid. React 19 — `ReactElement`, no global `JSX`.
  Files: `apps/mobile/src/screens/discover/__tests__/**`, `apps/mobile/app/(app)/discover/__tests__/**`,
  `apps/mobile/tests/discover-commerce/**`.
  Verify: `npm test` green; `APP_PROFILE=development npm run bundle` and
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 7. Flip the lane's 12 parity rows to `native` and verify: `node scripts/native/parity-ledger.mjs --sync`
  (status edited by hand to `native` for this lane's rows only), then `--check`.
  Files: `apps/mobile/parity/ledger.json` (discover rows only), `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 8. **(depends-on-owner / G1 — `next_actor: owner`)** Device-runtime parity: Maestro journey(s)
  `apps/mobile/maestro/discover-commerce/discover-*.yaml`, iOS simulator + Android emulator screenshots at the device
  sizes, screenshot parity vs the 390×844 read-only staging web `/discover` + `/shop` + the sub-catalogues. Blocked
  until G1 (and macOS minutes / G3 for iOS on a device).
  Files: `apps/mobile/maestro/discover-commerce/**`, `docs/validation/<VTID>/staging-tests.json`.
  Verify: on G1 only; recorded in the lane log, not run in CI.
- [ ] 9. PR: branch `kiro/native-wave2-discover-commerce/discover`, title
  `VTID-xxxxx (native-wave2-discover-commerce/discover): native discover + shop port`, body names the Kiro session id,
  Summary / Decisions taken / Tests / **UX acceptance** (user steps · required fields · decisions · anything the AI
  could infer = "none" · can the user always tell what to do next · friction unchanged) / Handoff. Commit trailers
  `Collab-Session: <kiro id>`, `Collab-Lane: native-wave2-discover-commerce/discover`. Lane → `in-review`,
  `next_actor: kiro` (reviewer seat `hotmail`). Never merge, deploy or write to a live system (protocol §7a).
<!-- lane: product-cart-checkout -->
## Lane `product-cart-checkout` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports (5 ledger rows): `DISCOVER.PRODUCT_DETAIL /discover/product/:id`, `DISCOVER.CART /universal-cart`, and the
exclusion rows `/checkout/success`, `/tickets/success`, `/packages/success`. depends_on: `discover` (for the
`AddToCartButton` native twin, design decision 3). Web sources `src/pages/discover/ProductDetail.tsx` (public, no
AuthGuard; PDP + affiliate buy external redirect), `src/pages/UniversalCart.tsx` (Warenkorb/Gemerkt tabs, quantity
steppers, wallet balance card, checkout idempotency, AI propose/reorder, `AddMoneyDialog` on insufficient balance),
`src/pages/CheckoutSuccess.tsx`, `src/pages/TicketPurchaseSuccess.tsx`, `src/pages/PackagePurchaseSuccess.tsx`.
**This lane carries every highest-priority iOS-IAP-gate flag.**
- [ ] 1. Core re-exports (only if needed): pure checkout-idempotency / money-format helpers (`checkout-idempotency`,
  `format-money` are already extractable-shaped) added to `@vitana/core` via the manifest + `core-closure.mjs
  --write`, generated files committed in-PR. The cart/checkout/wallet gateway hooks (`useUniversalCart`, `useDeposit`,
  the wallet client) are class B and re-implemented natively — **never moved into core.** If this lane extracts no
  pure helper it adds no manifest entry and no generated-file churn.
  Files: `packages/core/manifest.json`, `packages/core/src/**`, `packages/core/closure.generated.json`,
  `scripts/native/mobile-ci-paths.generated.json`.
  Verify (repo root): `node scripts/native/core-closure.mjs --check`; `apps/mobile` → `npm run typecheck` green.
- [ ] 2. Product detail `apps/mobile/app/(app)/discover/product/[id].tsx` +
  `apps/mobile/src/screens/commerce/ProductDetailScreen.tsx`: public PDP twin of `ProductDetail.tsx` (no AuthGuard;
  reward-points preview; the `AddToCartButton` twin consumed via the port from `discover`; affiliate "Buy" external
  redirect via `getRedirectUrl`). Mobile-web branch only. **Flag the add-to-cart leg + the affiliate external buy as
  purchase surfaces** (iOS gate, today's behaviour; the affiliate external link is a real-world redirect, lower IAP
  risk — record it as such, change nothing).
  Files: `apps/mobile/app/(app)/discover/product/[id].tsx`, `apps/mobile/src/screens/commerce/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 3. Universal cart `apps/mobile/app/(app)/universal-cart.tsx` +
  `apps/mobile/src/screens/commerce/UniversalCartScreen.tsx`: twin of `UniversalCart.tsx` — Warenkorb/Gemerkt tabs,
  quantity steppers, the wallet-balance card twin, checkout with idempotency preserved, AI propose/reorder, affiliate
  redirects, and the `AddMoneyDialog` twin shown on insufficient balance. **Flag checkout and the `AddMoneyDialog`
  wallet top-up as the highest-priority iOS-IAP-gate surfaces** (today's behaviour — the shell already hides `wallet`
  on iOS; decision deferred, change nothing).
  Files: `apps/mobile/app/(app)/universal-cart.tsx`, `apps/mobile/src/screens/commerce/**`.
  Verify: `npm test` (quantity steppers, checkout idempotency, add-money-on-insufficient-balance) + `npm run typecheck`
  green.
- [ ] 4. Success confirmations: `apps/mobile/app/(app)/checkout/success.tsx` (post-checkout; `?checkout_id` refreshes
  the cart; `?deposit_id` polls the Stripe wallet top-up status via the native `useDeposit` twin —
  **flag the deposit-return leg as a wallet-top-up purchase surface**, today's behaviour),
  `apps/mobile/app/(app)/tickets/success.tsx`, `apps/mobile/app/(app)/packages/success.tsx` (post-purchase
  confirmations, public routes). Twins of `CheckoutSuccess.tsx`, `TicketPurchaseSuccess.tsx`,
  `PackagePurchaseSuccess.tsx`.
  Files: `apps/mobile/app/(app)/checkout/**`, `apps/mobile/app/(app)/tickets/success.tsx`,
  `apps/mobile/app/(app)/packages/success.tsx`, `apps/mobile/src/screens/commerce/**`.
  Verify: `npm test` (checkout-id refresh, deposit-id poll states, ticket/package confirmation) + `npm run typecheck`
  green.
- [ ] 5. i18n + RTL (as discover task 5) for the product detail, cart and three success screens; new keys DE-first in
  the shared `src/i18n/de/discoverCommerceNative.json` then the other ten.
  Files: `src/i18n/*/discoverCommerceNative.json` (DE first), `apps/mobile/src/screens/commerce/**`.
  Verify: `npm run typecheck`; `npm test` no-raw-text / no-physical-direction tests pass.
- [ ] 6. Unit tests (fake gateway / fixtures): PDP loaded / not-found / error + add-to-cart gate + affiliate redirect;
  cart loaded / empty / error, quantity steppers, checkout idempotency (same key → one order), insufficient balance →
  `AddMoneyDialog`; `/checkout/success` with `?checkout_id` and with `?deposit_id` poll; tickets/packages success.
  React 19 `ReactElement`.
  Files: `apps/mobile/src/screens/commerce/__tests__/**`, `apps/mobile/app/(app)/**/__tests__/**`,
  `apps/mobile/tests/discover-commerce/**`.
  Verify: `npm test`; `APP_PROFILE=development npm run bundle`;
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 7. Flip the lane's 5 parity rows (`DISCOVER.PRODUCT_DETAIL`, `DISCOVER.CART`, `/checkout/success`,
  `/tickets/success`, `/packages/success`) to `native`; `--sync` then `--check`.
  Files: `apps/mobile/parity/ledger.json` (this lane's 5 rows only),
  `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 8. **(depends-on-owner / G1 — `next_actor: owner`)** Device-runtime parity: Maestro
  `apps/mobile/maestro/discover-commerce/cart-*.yaml` + sim/emulator screenshots + parity vs the 390×844 read-only
  staging `/discover/product/:id`, `/universal-cart`, `/checkout/success`, `/tickets/success`, `/packages/success`.
  Blocked until G1 (+ macOS/G3 for iOS). The purchase-flow specs stay read-only — never complete a real checkout or a
  real wallet top-up against a live system.
  Files: `apps/mobile/maestro/discover-commerce/**`, `docs/validation/<VTID>/staging-tests.json`.
- [ ] 9. PR: branch `kiro/native-wave2-discover-commerce/product-cart-checkout`, title
  `VTID-xxxxx (native-wave2-discover-commerce/product-cart-checkout): native product + cart + checkout port`; body
  Summary / Decisions taken / Tests / **UX acceptance** (friction unchanged; every purchase surface's iOS-IAP-gate
  flag recorded with today's behaviour) / Handoff; trailers `Collab-Session`,
  `Collab-Lane: native-wave2-discover-commerce/product-cart-checkout`; lane → `in-review`, `next_actor: kiro`. No
  merge/deploy/live write.
<!-- lane: marketplace-orders -->
## Lane `marketplace-orders` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports (9 ledger rows): `DISCOVER.MARKETPLACE /discover/marketplace`,
`DISCOVER.MARKETPLACE_MINE /discover/marketplace?view=mine`,
`DISCOVER.MARKETPLACE_OPEN /discover/marketplace?view=open`, `DISCOVER.DOCTORS_COACHES /discover/doctors-coaches`,
`DISCOVER.PROVIDER_PROFILE /discover/provider/:id`, `DISCOVER.ORDERS /discover/orders`,
`DISCOVER.ORDERS_ACTIVE /discover/orders?tab=active`, `DISCOVER.ORDERS_HISTORY /discover/orders?tab=history`,
`DISCOVER.MY_TICKETS /my-tickets`. depends_on: none. No add-to-cart / checkout control anywhere in this lane, so no
iOS-IAP-gate flag applies to any of its 9 rows. Web sources `src/pages/discover/Marketplace.tsx` (intents board,
commercial_buy + commercial_sell + affiliate), `DoctorsCoaches.tsx`, `ProviderProfile.tsx`,
`src/pages/discover/Orders.tsx` (`MobileOrdersView` branch; active/history tabs; CJ orders + tickets + vouchers),
`src/pages/MyTickets.tsx`; shared control `src/components/orders/MobileOrdersView.tsx` (this lane owns the twin).
- [ ] 1. Core re-exports (only if class A): any pure intents/orders helper the marketplace and orders screens use,
  added to `@vitana/core` via the manifest + `core-closure.mjs --write` with the generated files committed in-PR. The
  `getIntentBoard` / `cj_orders` / `useMyTickets` / `useMyVouchers` fetching is class B and re-implemented natively,
  reusing the web member-listing / provider queries unchanged so any test/service allowlist exclusion (program NEVER
  45) is inherited, not re-implemented. Default: consume core, add nothing.
  Files: `packages/core/manifest.json`, `packages/core/src/**`, `packages/core/closure.generated.json`,
  `scripts/native/mobile-ci-paths.generated.json`.
  Verify (repo root): `node scripts/native/core-closure.mjs --check`; `apps/mobile` → `npm run typecheck` green.
- [ ] 2. Marketplace: `apps/mobile/app/(app)/discover/marketplace.tsx` + `src/screens/marketplace-orders/*` — the
  intents board (commercial_buy + commercial_sell + affiliate) with the `view=mine` / `view=open` filters via the
  `view` search param and the mobile compact utility bar. Twin of `Marketplace.tsx`. No direct cart control.
  Files: `apps/mobile/app/(app)/discover/marketplace.tsx`, `apps/mobile/src/screens/marketplace-orders/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 3. Doctors & coaches + provider profile: `apps/mobile/app/(app)/discover/doctors-coaches.tsx` (gated provider
  list) and `apps/mobile/app/(app)/discover/provider/[id].tsx` (provider detail; booking is elsewhere, out of
  cluster). Twins of `DoctorsCoaches.tsx`, `ProviderProfile.tsx`.
  Files: `apps/mobile/app/(app)/discover/doctors-coaches.tsx`, `apps/mobile/app/(app)/discover/provider/[id].tsx`,
  `apps/mobile/src/screens/marketplace-orders/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 4. Orders + my-tickets: `apps/mobile/app/(app)/discover/orders.tsx` renders the `MobileOrdersView` twin
  (active/history tabs via the `tab` param, unified tickets / CJ orders / vouchers — view/track only, no buy);
  `apps/mobile/app/(app)/my-tickets.tsx` the purchased-tickets list/detail. Twins of `Orders.tsx`, `MyTickets.tsx`.
  Files: `apps/mobile/app/(app)/discover/orders.tsx`, `apps/mobile/app/(app)/my-tickets.tsx`,
  `apps/mobile/src/screens/marketplace-orders/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 5. i18n + RTL (as discover task 5) across all marketplace-orders screens; new keys DE-first in the shared
  `src/i18n/de/discoverCommerceNative.json` then the other ten.
  Files: `src/i18n/*/discoverCommerceNative.json` (DE first), `apps/mobile/src/screens/marketplace-orders/**`.
  Verify: `npm run typecheck`; `npm test` no-raw-text / no-physical-direction tests pass.
- [ ] 6. Unit tests (fake gateway / fixtures) per screen type: marketplace board load / `view=mine` / `view=open` /
  empty / error; doctors list + provider profile open from list and deep link + back; orders active/history tab
  switch + empty + error; my-tickets list/detail. React 19 `ReactElement`.
  Files: `apps/mobile/src/screens/marketplace-orders/__tests__/**`, `apps/mobile/app/(app)/**/__tests__/**`,
  `apps/mobile/tests/discover-commerce/**`.
  Verify: `npm test`; `APP_PROFILE=development npm run bundle`;
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 7. Flip the lane's 9 parity rows to `native`; `--sync` then `--check`.
  Files: `apps/mobile/parity/ledger.json` (marketplace-orders rows only),
  `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 8. **(depends-on-owner / G1 — `next_actor: owner`)** Maestro `apps/mobile/maestro/discover-commerce/
  marketplace-*.yaml` + sim/emulator screenshots + parity vs the 390×844 read-only staging screens. Blocked until G1
  (+ macOS/G3 for iOS).
  Files: `apps/mobile/maestro/discover-commerce/**`, `docs/validation/<VTID>/staging-tests.json`.
- [ ] 9. PR: branch `kiro/native-wave2-discover-commerce/marketplace-orders`, title
  `VTID-xxxxx (native-wave2-discover-commerce/marketplace-orders): native marketplace + orders port`; body Summary /
  Decisions taken / Tests / **UX acceptance** (friction unchanged; no purchase surface in this lane) / Handoff;
  trailers `Collab-Session`, `Collab-Lane: native-wave2-discover-commerce/marketplace-orders`; lane → `in-review`,
  `next_actor: kiro`. No merge/deploy/live write.
## Acceptance (every lane; the reviewer seat checks these)
- Requirements R1–R6 met for the lane's screens; mobile-web parity (`useIsMobile()` ≤ 1024 branch;
  `MobileDiscoverView` for `/discover`, `MobileOrdersView` for `/discover/orders`, the immersive feed for `/shop`),
  N2/N3 composition, `@vitana/core`-only bridge.
- `npm run typecheck`, `npm test`, `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green; `node scripts/native/parity-ledger.mjs --check`
  green with the lane's rows `native`; `node scripts/native/core-closure.mjs --check` green (and, for a
  core-extracting lane, the regenerated `closure.generated.json` + `mobile-ci-paths.generated.json` committed in-PR).
- 11 locales, DE-first new keys, RTL covered; no hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** and **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (read-only) and `plan-sparring.md`.
- **Commerce UX contract:** the PR's "UX acceptance" section is present; friction is unchanged vs the web original;
  no onboarding step/field/dialog added; every purchase surface carries its iOS-IAP-gate flag recording today's
  behaviour (gate decision deferred — behaviour not changed in this port). No class-B module moved into core.
- Device-runtime parity (task 8) is deferred to G1 as `next_actor: owner`; it is not a merge blocker for the port, it
  is recorded in the lane log and `staging-tests.json`.
- Never: VTID allocation, merge/approve, workflow dispatch, deploy, Supabase/AWS writes, or any test against
  production (protocol §7a; program §6).
