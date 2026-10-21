---
lane: discover
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(app)/discover/index.tsx
  - apps/mobile/app/(app)/discover/supplements.tsx
  - apps/mobile/app/(app)/discover/wellness-services.tsx
  - apps/mobile/app/(app)/discover/deals-offers.tsx
  - apps/mobile/app/(app)/discover/category/**
  - apps/mobile/app/(app)/shop.tsx
  - apps/mobile/src/screens/discover/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/maestro/discover-commerce/**
  - apps/mobile/tests/discover-commerce/**
  - packages/core/manifest.json
  - packages/core/closure.generated.json
  - packages/core/src/**
  - scripts/native/mobile-ci-paths.generated.json
  - apps/mobile/parity/ledger.json
  - src/i18n/*/discoverCommerceNative.json
  - docs/validation/**
updated: 2026-10-21T13:30Z
vtid:
---
# Discover + shop port — `/discover` (+ tabs), `/shop` (immersive video feed), the discover sub-catalogues
Plan: `.kiro/specs/native-wave2-discover-commerce/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: discover -->` (tasks 1–9) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start
before `vtid:` is set here. No deps — runs in parallel with `marketplace-orders`. This lane owns the shared
`AddToCartButton` + `MobileDiscoverView` native twins and the core extraction.
**Measured on the worktree (= origin/main of `exafyltd/vitana-v1`):** 12 ledger rows under
`"lane": "discover-commerce"` for this lane, all `not_started` — `DISCOVER.OVERVIEW /discover`,
`DISCOVER.AI_PICKS /discover?tab=suggested`, `DISCOVER.CATEGORIES /discover?tab=categories`,
`DISCOVER.SHARE_EARN /discover?tab=share`, `DISCOVER.SHOP /shop`, `DISCOVER.SUPPLEMENTS /discover/supplements`,
`DISCOVER.WELLNESS_SERVICES /discover/wellness-services`, `DISCOVER.DEALS /discover/deals-offers`,
`DISCOVER.DEALS_TRENDING /discover/deals-offers?tab=trending`, `DISCOVER.DEALS_AI /discover/deals-offers?tab=ai`,
`DISCOVER.DEALS_SAVED /discover/deals-offers?tab=saved`, and the exclusion row `/discover/category/:subcategory`
(11 registry + 1 exclusion = 12). Web sources `src/pages/Discover.tsx` (`MobileDiscoverView` + `MobileModePill`
branch), `src/pages/ShopFeed.tsx` (the one immersive vertical-snap video feed in the cluster),
`src/pages/discover/Supplements.tsx`, `WellnessServices.tsx`, `DealsOffers.tsx`, `CategoryProducts.tsx`; shared
controls `src/components/cart/AddToCartButton.tsx`, `src/components/discover/MobileDiscoverView.tsx`; routes at
`src/App.tsx:1029-1113`. Data-fetching hooks reused natively (class B, not moved into core):
`useMarketplaceFeed`/`useMarketplaceSearch`/`useShopFeed`/`useShopVideoAnchor`/`useShopEvents`.
**Goal.** Port the discover overview + its suggested/categories/share tabs, the supplements / wellness / deals
sub-catalogues, `/discover/category/:subcategory`, and the `/shop` immersive video feed to native on the N3 shell at
1:1 mobile-web parity: the `MobileDiscoverView` twin + `MobileModePill`, the `allowGuest` grids hosting the
`AddToCartButton` twin, and the full-screen vertical-snap `/shop` feed (anchor pill → peek drawer → PDP drawer,
autoplay/pause, `<video>`→`expo-video`). The pure discover/shop helpers move into `@vitana/core` (task 1) rather than
being re-implemented; the fetching hooks are re-implemented natively. **Every add-to-cart surface is flagged for the
iOS `isIAPRestricted` gate with today's behaviour unchanged** (decision deferred). Flips the 12 parity rows to
`native`.
**Acceptance (the reviewer seat checks these):**
- Requirements R1–R6 for the discover surfaces; mobile-web parity (`MobileDiscoverView` branch; `/shop` immersive);
  `@vitana/core`-only web bridge; the `AddToCartButton` + `MobileDiscoverView` twins owned here and exported via a
  port for `product-cart-checkout`.
- `npm run typecheck`, `npm test` (discover loaded/empty/error; mode-pill tab switch; add-to-cart gate + role-block;
  `/shop` autoplay/pause + anchor→PDP; each sub-catalogue + category grid), `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (from `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/core-closure.mjs --check` and `node scripts/native/parity-ledger.mjs --check` green with the 12
  rows `native` and their routes present in `apps/mobile/app/`; the regenerated `packages/core/closure.generated.json`
  + `scripts/native/mobile-ci-paths.generated.json` committed in this PR.
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form) then mirrored; RTL (`ar`) covered; no
  hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (this lane's read-only spec) and `plan-sparring.md`.
- **Commerce UX contract:** PR "UX acceptance" section present; friction unchanged; no onboarding step added; each
  add-to-cart surface's iOS-IAP-gate flag recorded (today's behaviour, deferred). No class-B module moved into core.
- **Device-runtime parity (task 8)** is deferred to G1 as `next_actor: owner`; not a merge blocker, recorded in this
  log and `staging-tests.json`.
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 12 rows), `packages/core/manifest.json`
+ closure + `src/**` (only this lane's re-exports — the pure discover/shop helpers) + `scripts/native/
mobile-ci-paths.generated.json`, `apps/mobile/src/ports/**`, `apps/mobile/src/navigation/resolve.ts`, and the DE-first
i18n shard `src/i18n/*/discoverCommerceNative.json` are shared by row/key with the other two lanes; resolve a merge
conflict by keeping both lanes' rows/keys.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only; the native app has no production profile.
## Log
### 2026-10-21T12:00Z · kiro-planner · created → ready
Lane drafted with the plan (`state: drafted` in `handoff.md`). The 12 rows and the paths were computed from the parity
ledger and `src/App.tsx` so no file belongs to two lanes; no deps — runs in parallel with `marketplace-orders`;
`product-cart-checkout` depends on this lane for the `AddToCartButton` twin. Next: PLAN-SPAR spars the plan; once a
VTID is written here, seat `exafyltd` claims the lane
(`queue.mjs claim native-wave2-discover-commerce/discover --session <id>`).
### 2026-10-21T13:30Z · kiro-planner · review fix (ready)
Plan review NIT (glob caveat): narrowed this lane's `app/(app)/discover/` `paths` from the recursive `discover/**`
glob to its own explicit leaves — `discover/index.tsx`, `discover/supplements.tsx`, `discover/wellness-services.tsx`,
`discover/deals-offers.tsx`, `discover/category/**` — plus `shop.tsx`, so PR-GATE Lane scope cannot pass a cross-lane
edit under `app/(app)/discover/` that belongs to `product-cart-checkout` (`product/**`) or `marketplace-orders`
(`marketplace.tsx`, `orders.tsx`, `provider/**`, `doctors-coaches.tsx`) by accident. Row/screen-subtree partition
unchanged (still 12 rows, 0 overlap). Also authored the spec's `requirements.md` + `design.md` this iteration
(see `handoff.md` log) so this lane's acceptance "Requirements R1–R6" now resolves. No product-behaviour change.
