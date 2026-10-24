# Plan — native-wave2-discover-commerce
Author: Kiro, seat `exafyltd`. Repo: `exafyltd/vitana-v1` (native app only — `apps/mobile/**`, `packages/core/**`
via the manifest/closure process, `apps/mobile/parity/ledger.json`, DE-first i18n shards, `docs/validation/**`; no
backend, no gateway change, no migration). Spec: `requirements.md`, `design.md`, `tasks.md`, `lanes/*.md` in this
folder. Program: `docs/programs/native-app/NATIVE-APP-PLAN.md` (VTID-05021), §5 Wave 2.
<!-- plan:begin -->
## Cross-repo sparring
This plan's implementation lives in `exafyltd/vitana-v1` (native app `apps/mobile/**`, `packages/core/**`, the parity
ledger, i18n shards), while the plan PR itself is in `exafyltd/vitana-platform`. Every load-bearing premise the
sparring partner must verify — the parity-ledger rows for `"lane": "discover-commerce"`, the `src/App.tsx` routes, and
the discover/commerce/cart/orders web source pages and their class-A/class-B module classification — is therefore a
vitana-v1 file. The partner reads those files through the `spar_refs` (`exafyltd/vitana-v1: main`) declared in
`handoff.md`, which PLAN-SPAR forwards as `extra_refs`; findings about the frontend half must cite vitana-v1 paths read
via that ref.
## Goal
Second Wave 2 screen-port batch of the native Maxina app: port the discover / commerce / cart / orders cluster — the
26 web destinations the parity ledger assigns to `"lane": "discover-commerce"` — to the native app (`apps/mobile/`) at
1:1 parity with today's **mobile web** screens (the `useIsMobile()` ≤ 1024 px branch), built on `@vitana/core` +
`@vitana/tokens` + the N2 UI kit (`@vitana/ui`) on the Wave 1 N3 shell, with fixture / fake-gateway unit tests. Does
**not** need G1 planned or built to land the ports; every device-runtime verification step is marked
depends-on-owner (G1). No redesign (program §4), no new web screen, no `App.tsx` route, no registry/manifest change —
only native route files and parity-row status flips. This is a **parity port**: it mirrors the existing mobile-web
behaviour exactly and adds no onboarding step, field, dialog, status or friction the web screen does not already have.

## Measured state (worktree = origin/main, parity ledger `apps/mobile/parity/ledger.json` version 2)
- **26 rows** carry `"lane": "discover-commerce"`, **all `status: "not_started"`** (22 `screen`/`registry`, 4
  `route`/`exclusion`); **435 rows total**. Counted with `node -e` over the committed ledger of `exafyltd/vitana-v1`
  on `origin/main` (the `--report` CLI needs `typescript`, not installed in this worktree; `--check` and `--sync` run
  fine). The 26 keys and their web paths are listed in `requirements.md` R0.2–R0.4 and in each lane's "Measured on the
  worktree" paragraph; they match the ledger exactly — no row invented.
- Web sources verified present on `origin/main` of `exafyltd/vitana-v1`, with the screens cross-checked against the
  routes in `src/App.tsx:1029-1113`: `src/pages/Discover.tsx` (hosts `MobileDiscoverView` + `MobileModePill`),
  `src/pages/ShopFeed.tsx` (the one immersive vertical-snap video feed), `src/pages/discover/Marketplace.tsx`,
  `src/pages/discover/Supplements.tsx`, `WellnessServices.tsx`, `DealsOffers.tsx`, `DoctorsCoaches.tsx`,
  `ProviderProfile.tsx`, `ProductDetail.tsx`, `CategoryProducts.tsx`, `src/pages/UniversalCart.tsx`,
  `src/pages/CheckoutSuccess.tsx`, `src/pages/discover/Orders.tsx`, `src/pages/MyTickets.tsx`,
  `TicketPurchaseSuccess.tsx`, `PackagePurchaseSuccess.tsx`; shared controls `components/cart/AddToCartButton.tsx`,
  `components/discover/MobileDiscoverView.tsx`, `components/orders/MobileOrdersView.tsx`.
- Wave 1 is on main: N3 shell + resolver route (`apps/mobile/app/(app)/[...path].tsx`, VTID-05186), N2 UI kit
  (`@vitana/ui`, VTID-05176), N1 `@vitana/core`/`@vitana/tokens` (VTID-05183). Prop map, ports and conventions in
  `apps/mobile/README.md`. The native app has no production profile; `assertNotProduction()` refuses prod/staging hosts.

## Decisions (made by Kiro as planner under the owner's "finish the native apps" instruction; sparring may revise)
1. **Three disjoint lanes by route/screen subtree** — `discover` (the discover overview + tabs, the discover
   sub-catalogues, and the `/shop` immersive video feed), `product-cart-checkout` (the product detail page and the
   full purchase/confirmation flow), `marketplace-orders` (the commercial-intent marketplace, provider directory, and
   the orders / tickets views). The three touch disjoint `app/(app)/<routes>/**` and `src/screens/<cluster>/**`
   subtrees, build/review independently, each leaves the app buildable, and match the model's own 3-lane shape and the
   owner's "multiple agents in parallel" directive. **Partition against the ledger: discover 12 rows,
   product-cart-checkout 5 rows, marketplace-orders 9 rows = 26** (registry 11+2+9 = 22; exclusion 1+3+0 = 4).
   `parity-ledger.mjs` matches by exact `shapeOf()`, not prefix, so an exclusion row such as `/checkout/success` is a
   dedicated row its owning lane must flip `not_started`→`native` — never "covered under `/discover`". Each lane's
   acceptance REQUIRES flipping every one of its rows to `native`.
2. **Only pure / class-A helpers move into `@vitana/core`; data-fetching hooks are re-implemented natively.** The
   discover feed/search/cards, cart/checkout and intents/orders all run through hooks that runtime-import
   `src/integrations/supabase/client.ts` (class B: `import.meta.env`, `localStorage`, the prod Supabase URL), so they
   fail the `core-closure.mjs` class-A gate and are re-implemented natively (native Supabase client + native auth
   context), exactly as the home-feed lane did. **Never move a class-B module into core.** Only genuinely IO-free
   helpers get a core re-export (e.g. price/format mappers, `discover-reason`, shop-feed pure mappers,
   `checkout-idempotency`, `format-money`). A core-extracting lane adds the manifest entry, runs
   `node scripts/native/core-closure.mjs --write`, and commits the regenerated `packages/core/closure.generated.json`
   + `scripts/native/mobile-ci-paths.generated.json` **in the same PR**, so `--check` passes.
3. **The `discover` lane owns the shared `AddToCartButton` native twin and the `MobileDiscoverView` twin**, exported
   via a port so each has exactly one owner and the lanes' `paths` stay disjoint. `product-cart-checkout` consumes the
   `AddToCartButton` twin through that port (web `src/components/cart/AddToCartButton.tsx` is the one purchase control
   shared across discover, supplements, wellness, deals, category and product-detail). Therefore
   **`product-cart-checkout` depends_on `[discover]`**; `discover` and `marketplace-orders` have no deps and run in
   parallel. `marketplace-orders` owns the `MobileOrdersView` twin.
4. **iOS IAP gate flagged per screen, behaviour unchanged.** `isIAPRestricted()` today = `Platform.OS === 'ios'`
   (`apps/mobile/src/shell/logic/drawer.ts:37-38`; the shell already hides `wallet` on iOS). Program decision 5 keeps
   today's behaviour and defers extending the gate to every digital purchase surface until an iOS store submission —
   **that decision is NOT made in this parity port.** Every purchase surface carries an explicit per-screen flag
   (`requirements.md` R5, the inventory in `design.md`) so the executor records it; the highest-priority flags all
   land in Lane 2 — the cart checkout, the `AddMoneyDialog` wallet top-up, and the `/checkout/success` deposit-return.
   The port must NOT silently add or remove any iOS gating; it only flags.
5. **No new routes / registry / manifest.** Ports of screens already in `App.tsx` + `screens.json`; a native Expo
   Router file is not an `App.tsx` route, so the "new page needs screens.json/exclusions.json + screen-manifest +
   parity rows" rule does not fire — only parity-row **status** flips (`not_started`→`in_progress`→`native`).
6. **Device-runtime verification deferred to G1** (owner gate). Lanes land with offline build + fake-gateway unit
   tests green; the Maestro / simulator / screenshot-parity pass is a `next_actor: owner` task recorded in the lane and
   `staging-tests.json`. Matches the program's "fixture / fake-gateway tests only until G1" model.
7. **Mobile-web parity, not desktop.** Each native screen mirrors the `useIsMobile()` ≤ 1024 px branch of its source
   (program §1 shell) — `MobileDiscoverView` for `/discover`, `MobileOrdersView` for `/discover/orders`, the immersive
   `storefront` archetype for `/shop`, `detail`/`collection`/`form` shapes elsewhere per the Spotlight contract —
   composed through N3/N2, every visual value from `@vitana/tokens`; no web file is touched beyond a DE-first i18n key
   and a `@vitana/core` re-export line.

## Commerce UX contract (CLAUDE.md — supplier onboarding, VTID-05204)
This is a **parity port**: mirror the EXISTING mobile-web behaviour exactly. Do NOT add any onboarding step, field,
dialog, status or friction the web screen does not already have — a change that increases onboarding friction is OUT
OF SCOPE here and would need separate explicit owner approval. The cluster in scope is the member-facing
discover / commerce / cart / orders screens, not supplier onboarding (`CommercePortalLogin` / `CommerceJoin` /
`CommercePortal` are NOT in the `discover-commerce` ledger lane and are NOT ported here). Where any supplier-facing
surface is touched at all, keep the AI-led, **one-dominant-action-per-screen**, no-technical-concepts-in-supplier-UX
shape of the web original. Every lane's PR carries a **"UX acceptance" section** — user steps · required fields ·
decisions · anything asked that Vitanaland or the AI could infer (must be "none" or justified) · can the user always
tell what to do next · friction up/down vs before. For a pure parity port the honest answer is "friction unchanged".

## Lanes (all `ready`, executor kiro; seat → reviewer_seat; `vtid:` filled by CI on convergence)
| Lane | Seat → reviewer | Scope (web destinations) | depends_on |
|---|---|---|---|
| `discover` | exafyltd → hotmail | `/discover` (+ `?tab=suggested\|categories\|share`), `/shop` (immersive video feed), `/discover/supplements`, `/discover/wellness-services`, `/discover/deals-offers` (+ `?tab=trending\|ai\|saved`), `/discover/category/:subcategory`; **owns the `AddToCartButton` + `MobileDiscoverView` native twins** and **the core extraction** — pure discover/shop helpers re-exported via `packages/core/manifest.json` + `src/**`, with `core-closure.mjs --write` run and `closure.generated.json` + `scripts/native/mobile-ci-paths.generated.json` committed in the same PR (**12 rows**) | — |
| `marketplace-orders` | exafyltd → hotmail | `/discover/marketplace` (+ `?view=mine\|open`), `/discover/doctors-coaches`, `/discover/provider/:id`, `/discover/orders` (+ `?tab=active\|history`), `/my-tickets`; owns the `MobileOrdersView` twin; no purchase control anywhere, so no IAP-gate flag applies (**9 rows**) | — |
| `product-cart-checkout` | exafyltd → hotmail | `/discover/product/:id`, `/universal-cart`, and the exclusion routes `/checkout/success`, `/tickets/success`, `/packages/success`; consumes the `AddToCartButton` twin via a port; **carries every highest-priority iOS-IAP-gate flag** — cart checkout, the `AddMoneyDialog` wallet top-up, the `?deposit_id` deposit-return on `/checkout/success` (**5 rows**) | `discover` |

Exact `paths` globs are in each `lanes/<id>.md`; the 26 parity rows partition **12 (discover) + 5
(product-cart-checkout) + 9 (marketplace-orders)** with 0 overlap and 0 orphan — registry 11+2+9 = 22, exclusion
1+3+0 = 4, summing to the ledger's 22 registry + 4 exclusion = 26. The four exclusion routes are dedicated rows the
owning lane flips to `native` (exact `shapeOf` match, not prefix). `discover` and `marketplace-orders` run in
parallel; `product-cart-checkout` waits for `discover` (the `AddToCartButton` twin).

## Test plan
- **Per lane, offline (fixture / fake gateway, no network):** from `apps/mobile/` — `npm run typecheck`, `npm test`
  (jest-expo + RNTL: loaded/empty/error per screen; discover feed + mode-pill tabs, add-to-cart gate states, `/shop`
  video autoplay/pause mapping; product-detail + cart quantity steppers + checkout idempotency + add-money-on-
  insufficient-balance + the three success screens; marketplace intents board, provider profile, orders active/history
  tabs, tickets; i18n no-raw-text + RTL start/end; React 19 `ReactElement`), `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check`. From the repo root —
  `node scripts/native/parity-ledger.mjs --check` (rows `native`, routes present).
- **Core extraction deliverable: run `--write` AND commit the generated files, not just `--check`.** The PR that adds
  a `@vitana/core` re-export entry (`discover` always; `product-cart-checkout` if it extracts pure checkout/money
  helpers) MUST also run `node scripts/native/core-closure.mjs --write` and commit the regenerated
  `packages/core/closure.generated.json` and `scripts/native/mobile-ci-paths.generated.json` in the SAME PR, then
  `node scripts/native/core-closure.mjs --check` passes. Without the `--write`+commit, `--check` fails in NATIVE-CI
  with "stale generated file" regardless of whether the modules are class A. **Never move a class-B module (anything
  that runtime-imports `src/integrations/supabase/client.ts`, `import.meta.env`, `localStorage`, etc.) into core** —
  the data-fetching hooks are re-implemented natively, only pure helpers are re-exported.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- **i18n:** 11 locales (ar de en es fr pl pt ru sr tr zh), any new key DE-first (du-form) then mirrored; RTL (`ar`)
  rendered per screen.
- **iOS IAP gate:** every purchase surface flagged per screen (R5 / the inventory) carries an explicit note recording
  today's behaviour — `isIAPRestricted()` = `Platform.OS === 'ios'` — with the gate decision deferred; the port does
  not change it.
- **Deferred to G1 (owner gate, `next_actor: owner`):** Maestro `apps/mobile/maestro/discover-commerce/*.yaml`, iOS
  simulator + Android emulator screenshots at the device sizes, screenshot parity vs the 390×844 **read-only** staging
  web screens; listed in `docs/validation/<VTID>/staging-tests.json` (sign in, navigate, read; network guard aborts
  every non-GET except sign-in; never `vitanaland.com`). STAGING-VERIFY is read-only by construction (program §6).
- **No What's New entry** (ports of existing screens). No new routes → no nav-registry change and no new native parity
  row — only status flips.

## Open owner / sparring items (not decided here)
- G1 isolated test environment (program gate) — required before any device-runtime parity check; the deferred tasks
  stay `next_actor: owner` until it exists.
- macOS minutes / G3 for iOS-on-device screenshots (program STATUS row 8b) — not needed for the JS build.
- The iOS-IAP-gate extension for digital purchase surfaces (program decision 5) — owner/store decision, deferred; this
  port only flags the surfaces and keeps today's behaviour.
- Whether the shared i18n shard stays single (`discoverCommerceNative.json`) or splits per lane
  (`discoverNative.json` / `cartOrdersNative.json` / `marketplaceOrdersNative.json`); default mirrors the model's
  single-shard-per-spec pattern.
<!-- plan:end -->
