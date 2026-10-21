# Requirements — Native Wave 2: Discover / Commerce / Cart / Orders screen ports (native-wave2-discover-commerce)
Second Wave 2 screen-port batch of the Maxina native app program
(`docs/programs/native-app/NATIVE-APP-PLAN.md`, program VTID-05021, §5 Wave 2). Port the discover, commerce, cart and
orders screens that the parity ledger assigns to the `discover-commerce` lane to the native app (`apps/mobile/`) at
1:1 parity with today's **mobile web** screens, built on `@vitana/core` + `@vitana/tokens` + the N2 UI kit
(`@vitana/ui`) on the N3 shell. Fixture / fake-gateway tests only; runtime verification on a device needs the isolated
test environment G1 and is called out per task as `depends-on-owner`.
Measured on the worktree (= `origin/main` of `exafyltd/vitana-v1`), parity ledger `apps/mobile/parity/ledger.json`
version 2: **26 rows carry `"lane": "discover-commerce"`, every one `status: "not_started"`** (22 `screen`/`registry`,
4 `route`/`exclusion`; 435 rows total). Counted with `node -e` over the committed ledger JSON (the `--report` command
needs `typescript`, which is not installed in this worktree; `--check` and `--sync` run). The three lanes below
partition those 26 rows with **disjoint `paths`**.
Contract that does not change: `docs/programs/native-app/NATIVE-APP-PLAN.md` §4 (parity method), §6 (verification &
safety), the N2 README web→native prop map (`apps/mobile/README.md` "Web → native prop map"), the Spotlight / design
rules via tokens, and the Commerce UX contract (`CLAUDE.md` supplier-onboarding, VTID-05204). No new web screen, no
`App.tsx` route, no `screens.json` / `exclusions.json` entry is added by this plan (ports only), so no `screen-manifest`
or voice-registry change and no new native parity row — only status flips on existing rows.

## R0 — Scope and the three lanes
0.1 The plan ports exactly the 26 web destinations the parity ledger lists under `"lane": "discover-commerce"`, split
into three disjoint lanes by route/screen subtree. No row is in two lanes; no row in scope is left without a lane.
Partition against the ledger: `discover` 12, `product-cart-checkout` 5, `marketplace-orders` 9 = **26** (registry
11 + 2 + 9 = 22; exclusion 1 + 3 + 0 = 4). `parity-ledger.mjs` matches by exact `shapeOf()` (query dropped), not
prefix, so an exclusion row such as `/checkout/success` is a dedicated row its owning lane must flip
`not_started`→`native` — never "covered under `/discover`".

0.2 Lane **`discover`** (12 rows) — the discover overview + its tabs, the discover sub-catalogues, and the `/shop`
immersive video feed. Registry rows (11): `DISCOVER.OVERVIEW /discover`, `DISCOVER.AI_PICKS /discover?tab=suggested`,
`DISCOVER.CATEGORIES /discover?tab=categories`, `DISCOVER.SHARE_EARN /discover?tab=share` (web `src/pages/Discover.tsx`,
hosts `MobileDiscoverView` + `MobileModePill`; route `src/App.tsx:1029-1113`); `DISCOVER.SHOP /shop` (web
`src/pages/ShopFeed.tsx`, the one immersive vertical-snap video feed); `DISCOVER.SUPPLEMENTS /discover/supplements`
(web `src/pages/discover/Supplements.tsx`, `allowGuest`); `DISCOVER.WELLNESS_SERVICES /discover/wellness-services`
(web `src/pages/discover/WellnessServices.tsx`, `allowGuest`); `DISCOVER.DEALS /discover/deals-offers`,
`DISCOVER.DEALS_TRENDING /discover/deals-offers?tab=trending`, `DISCOVER.DEALS_AI /discover/deals-offers?tab=ai`,
`DISCOVER.DEALS_SAVED /discover/deals-offers?tab=saved` (web `src/pages/discover/DealsOffers.tsx`, `allowGuest`). Plus
1 exclusion: `/discover/category/:subcategory` (web `src/pages/discover/CategoryProducts.tsx`, `allowGuest`).

0.3 Lane **`product-cart-checkout`** (5 rows) — the product detail page and the full purchase / confirmation flow.
Registry rows (2): `DISCOVER.PRODUCT_DETAIL /discover/product/:id` (web `src/pages/discover/ProductDetail.tsx`,
**public**, PDP with `AddToCartButton` + affiliate "Buy" external redirect) and `DISCOVER.CART /universal-cart` (web
`src/pages/UniversalCart.tsx`, gated; Warenkorb/Gemerkt tabs, quantity steppers, wallet-balance card, checkout with
idempotency, AI propose/reorder, `AddMoneyDialog` on insufficient balance, affiliate redirects). Plus 3 exclusions:
`/checkout/success` (web `src/pages/CheckoutSuccess.tsx`, post-checkout confirmation; `?checkout_id` refreshes cart,
`?deposit_id` polls Stripe wallet top-up), `/tickets/success` (web `src/pages/TicketPurchaseSuccess.tsx`), and
`/packages/success` (web `src/pages/PackagePurchaseSuccess.tsx`). These are the reader/confirmation leaves the cart and
purchase pushes link into; the lane consumes the `AddToCartButton` native twin that `discover` owns (R0.2), so it
`depends_on: [discover]`.

0.4 Lane **`marketplace-orders`** (9 rows, 0 exclusion) — the commercial-intent marketplace, the provider directory,
and the orders / tickets views; no purchase control anywhere. Registry rows: `DISCOVER.MARKETPLACE
/discover/marketplace`, `DISCOVER.MARKETPLACE_MINE /discover/marketplace?view=mine`, `DISCOVER.MARKETPLACE_OPEN
/discover/marketplace?view=open` (web `src/pages/discover/Marketplace.tsx`, intents board + affiliate, no direct cart);
`DISCOVER.DOCTORS_COACHES /discover/doctors-coaches` (web `src/pages/discover/DoctorsCoaches.tsx`, gated provider list);
`DISCOVER.PROVIDER_PROFILE /discover/provider/:id` (web `src/pages/discover/ProviderProfile.tsx`);
`DISCOVER.ORDERS /discover/orders`, `DISCOVER.ORDERS_ACTIVE /discover/orders?tab=active`, `DISCOVER.ORDERS_HISTORY
/discover/orders?tab=history` (web `src/pages/discover/Orders.tsx`, renders `MobileOrdersView` active/history);
`DISCOVER.MY_TICKETS /my-tickets` (web `src/pages/MyTickets.tsx`, gated purchased-tickets list). Routes cross-checked
in `src/App.tsx:1029-1113`.

## R1 — 1:1 parity with the mobile web screen
1.1 Each native screen mirrors the **mobile web** branch (the `useIsMobile()` ≤ 1024 px branch,
`src/hooks/use-mobile.tsx`) of its web source — same layout, same sections, same navigation, same wording. No
redesign, no added or removed section, no reordering (program §4 "Allowed native improvements only": platform
transitions, gestures, keyboard avoidance, safe areas, haptics, system sheets — nothing else). `/discover` is the
`MobileDiscoverView` + `MobileModePill` branch; `/discover/orders` is the `MobileOrdersView` branch; `/shop` is the
immersive vertical-snap video feed.
1.2 Screens compose through the N3 shell and the N2 UI kit only: `MobileAppShell`, `TopAppBar`, `BottomNav`,
`MobileModePill`, bottom sheets, `VCard`, etc. come from `src/ports/*` (`apps/mobile/README.md` "Ports"); no web
component, no raw colour, every visual value from `@vitana/tokens`.
1.3 Web→native translation follows the README map exactly (`onClick`→`onPress`, `className`→`style`,
`toast`→`@vitana/ui/sonner`, documented `Select`/`Tooltip`/close-button/`Slider`/`Progress` differences). The four web
defects the N2 README lists (slider range thumb, progress RTL fill, inert `shouldScaleBackground`, close-button RTL
side) are **not** reproduced — the native kit's corrected behaviour is used, and no web file is touched.
1.4 Business logic, query keys, hooks, types and feed/search composition are reused from `@vitana/core` **only when
the module is pure / class-A**; a data-fetching hook that runtime-imports `src/integrations/supabase/client.ts`,
`import.meta.env` or `localStorage` is class-B and is re-implemented natively (native Supabase client + native auth),
never moved into core. A pure web module a lane needs that is not yet re-exported is added to
`packages/core/manifest.json` with a re-export in the same lane PR and `node scripts/native/core-closure.mjs --write`
run, the regenerated `packages/core/closure.generated.json` + `scripts/native/mobile-ci-paths.generated.json`
committed in that PR (program §3; `apps/mobile/README.md` "Web code: `@vitana/core`"). `@vitana/core` is the only
web→native bridge; ESLint bans `@/` and relative paths into the web `src/` from app code.
1.5 The shared purchase control `AddToCartButton` (`src/components/cart/AddToCartButton.tsx`) is ported once as a
native twin owned by the `discover` lane and consumed by `product-cart-checkout` through a port, so the two lanes'
`paths` stay disjoint (R0.3). It keeps the web gate: signed-out → sign-in (`useAuth`), role-block via
`useUniversalCart`, only `product`-typed UUID items enter the cart. The `MobileDiscoverView` twin is owned by
`discover`; the `MobileOrdersView` twin by `marketplace-orders`.

## R2 — i18n (11 locales) + RTL
2.1 Every user-visible string (including `accessibilityLabel` / `accessibilityHint`) comes from the web catalog shards
`src/i18n/<locale>/*.json`, read through the generated catalog map — no hardcoded text (repo i18n hard rule;
`apps/mobile/README.md` "i18n"). New keys for this cluster live in `src/i18n/<locale>/discoverCommerceNative.json`.
2.2 All 11 active locales resolve: **ar de en es fr pl pt ru sr tr zh** (program §1 design-system note; the live
`supported_locales` table has all 11 `status='ga'`). A new key is added to the **German shard first**
(`src/i18n/de/discoverCommerceNative.json`) then mirrored to the other ten; DE is du-form.
2.3 Each screen works in RTL (`ar`): `start`/`end`, never `left`/`right`; the shell root `direction` follows the
language (`apps/mobile/README.md` N3 "Theme" row). A test scans the lane's files for physical `left`/`right`.
2.4 Adding a web i18n key is a web-deploy path. A lane that needs a genuinely new string adds the DE key first and
mirrors it; a lane that can reuse an existing key does so and adds none. The three lanes share the single
`discoverCommerceNative.json` shard by key; a merge conflict is resolved by keeping both lanes' keys.

## R3 — React 19 / native typing
3.1 React 19 types: no global `JSX` namespace — use `ReactElement` (program hard rule; `.kiro/specs/health-native`
handoff "Hard rules"). `npm run typecheck` (which regenerates the i18n map first) is green.

## R4 — Parity ledger
4.1 Each lane flips its rows from `not_started` to `in_progress` while building and to `native` on completion by
running `node scripts/native/parity-ledger.mjs --sync` (status is edited by hand; `--sync` refreshes derived fields),
and NATIVE-CI `--check` is green: a `native` / `in_progress` row must have a matching route in `apps/mobile/app/`, and
no route in `app/` may lack a row (`scripts/native/parity-ledger.mjs` `check()`). A lane's acceptance REQUIRES flipping
every one of its rows to `native`; the four exclusion routes are dedicated rows the owning lane flips (exact `shapeOf`
match, not prefix).
4.2 No lane changes `scope`/`lane` of a row (those come from `scripts/native/parity-scope.json`); no lane edits another
lane's rows. The three lanes touch disjoint sets of ledger rows, so the single `ledger.json` file is the one shared
path and conflicts resolve by row.

## R5 — iOS IAP gate (every purchase surface flagged, behaviour unchanged)
5.1 `isIAPRestricted()` today = `Platform.OS === 'ios'` (`apps/mobile/src/shell/logic/drawer.ts:37-38`; the shell
already hides `wallet` on iOS). Program decision 5 keeps today's behaviour and defers extending the gate to every
digital purchase surface until an iOS store submission — **that decision is NOT made in this parity port.** This is a
parity port: it must NOT silently add or remove any iOS gating; it only **flags** each purchase surface so the executor
records it (today's behaviour, gate decision deferred). A screen is a *purchase surface* if it renders an
add-to-cart / buy / checkout / top-up / ticket-or-voucher-buy control, OR is a post-purchase confirmation of such a
flow.
5.2 Per-purchase-surface flag table. "iOS-IAP-gate flag" = the surface the executor records as a candidate for the
`isIAPRestricted` gate before an iOS store submission; default behaviour is unchanged.

| key | web_path | lane | purchase surface | iOS-IAP-gate flag (default = today's behaviour) |
|---|---|---|---|---|
| DISCOVER.OVERVIEW | `/discover` | discover | yes (hosts `AddToCartButton` on cards) | flag: add-to-cart leg |
| DISCOVER.AI_PICKS | `/discover?tab=suggested` | discover | yes | flag: add-to-cart leg |
| DISCOVER.CATEGORIES | `/discover?tab=categories` | discover | no (browse only) | n/a |
| DISCOVER.SHARE_EARN | `/discover?tab=share` | discover | no | n/a |
| DISCOVER.SHOP | `/shop` | discover | yes (add-to-cart, `source_surface:'video_shop'`) | flag: add-to-cart leg |
| DISCOVER.SUPPLEMENTS | `/discover/supplements` | discover | yes (`AddToCartButton`) | flag: add-to-cart leg |
| DISCOVER.WELLNESS_SERVICES | `/discover/wellness-services` | discover | yes (`AddToCartButton`) | flag: add-to-cart leg |
| DISCOVER.DEALS | `/discover/deals-offers` | discover | yes (`AddToCartButton`) | flag: add-to-cart leg |
| DISCOVER.DEALS_TRENDING | `/discover/deals-offers?tab=trending` | discover | yes | flag: add-to-cart leg |
| DISCOVER.DEALS_AI | `/discover/deals-offers?tab=ai` | discover | yes | flag: add-to-cart leg |
| DISCOVER.DEALS_SAVED | `/discover/deals-offers?tab=saved` | discover | yes | flag: add-to-cart leg |
| `/discover/category/:subcategory` | `/discover/category/:subcategory` | discover | yes (`AddToCartButton`) | flag: add-to-cart leg |
| DISCOVER.PRODUCT_DETAIL | `/discover/product/:id` | product-cart-checkout | yes (add-to-cart + affiliate buy) | flag: add-to-cart leg (affiliate external link is a real-world redirect, lower IAP risk) |
| DISCOVER.CART | `/universal-cart` | product-cart-checkout | **yes — primary checkout + wallet top-up** | **flag (highest priority): checkout + `AddMoneyDialog` wallet top-up** |
| `/checkout/success` | `/checkout/success` | product-cart-checkout | **yes — post-purchase confirmation + wallet-deposit return** | **flag (highest priority): `?deposit_id` deposit-return leg** |
| `/tickets/success` | `/tickets/success` | product-cart-checkout | yes (post-purchase confirmation) | flag: confirmation of a purchase |
| `/packages/success` | `/packages/success` | product-cart-checkout | yes (post-purchase confirmation) | flag: confirmation of a purchase |
| DISCOVER.MARKETPLACE / _MINE / _OPEN | `/discover/marketplace(?view=…)` | marketplace-orders | no (intents / affiliate, no direct cart) | n/a |
| DISCOVER.DOCTORS_COACHES | `/discover/doctors-coaches` | marketplace-orders | no (directory) | n/a |
| DISCOVER.PROVIDER_PROFILE | `/discover/provider/:id` | marketplace-orders | no (profile; booking is elsewhere) | n/a |
| DISCOVER.ORDERS / _ACTIVE / _HISTORY | `/discover/orders(?tab=…)` | marketplace-orders | no (view / track only) | n/a |
| DISCOVER.MY_TICKETS | `/my-tickets` | marketplace-orders | no (view purchased tickets) | n/a |

5.3 The highest-priority flags (cart checkout, the `AddMoneyDialog` wallet top-up, the `/checkout/success`
deposit-return) all land in the `product-cart-checkout` lane; `marketplace-orders` carries no flag (no purchase
control on any of its 9 rows). Every flagged screen's native port records the flag in `docs/validation/<VTID>/` with
the note "today's behaviour — `isIAPRestricted()` = `Platform.OS === 'ios'`, gate extension deferred (program
decision 5)".

## R5a — Commerce UX contract (CLAUDE.md supplier onboarding, VTID-05204)
5a.1 This is a parity port: mirror the EXISTING mobile-web behaviour exactly. Do NOT add any onboarding step, field,
dialog, status or friction the web screen does not already have — a change that increases onboarding friction is OUT
OF SCOPE and needs separate explicit owner approval. The cluster in scope is the member-facing
discover / commerce / cart / orders screens, not supplier onboarding (`CommercePortalLogin` / `CommerceJoin` /
`CommercePortal` are NOT in the `discover-commerce` ledger lane and are NOT ported here).
5a.2 Where any supplier-facing surface is touched at all, keep the AI-led, one-dominant-action-per-screen,
no-technical-concepts-in-supplier-UX shape of the web original. Every lane's PR carries a "UX acceptance" section —
user steps · required fields · decisions · anything asked that Vitanaland or the AI could infer (must be "none" or
justified) · can the user always tell what to do next · friction up/down vs before. For a pure parity port the honest
answer is "friction unchanged".

## R5b — Verification and safety (never production)
5b.1 Never test against production; staging specs are read-only (program §6; root `CLAUDE.md`). The native app has
**no production profile** and `assertNotProduction()` refuses the production gateway, `vitanaland.com`, the production
Supabase project and the staging hosts (`apps/mobile/README.md` "No production host, ever").
5b.2 Build-time verification per lane is offline: `npm run typecheck`, `npm test` (jest-expo + RNTL unit tests with a
**fake gateway / fixtures**, no network), `APP_PROFILE=development npm run bundle` (Metro + Hermes JS for iOS and
Android), and `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` — all from `apps/mobile/`; plus
`node scripts/native/parity-ledger.mjs --check` (and `node scripts/native/core-closure.mjs --check` for a
core-extracting lane) from the repo root. No live call is made.
5b.3 Runtime parity verification (simulator / emulator screenshots, Maestro device journeys
`apps/mobile/maestro/discover-commerce/*.yaml`, screenshot parity vs the 390×844 web screen) is a **depends-on-owner
(G1)** step: it needs the isolated test environment (and macOS minutes / G3 for iOS on a device). Each such task is
marked `next_actor: owner` in `tasks.md` and the lane records G1 as a blocker in its log; it does not block the
build-time port landing.
5b.4 Each lane adds a read-only `docs/validation/<VTID>/staging-tests.json` for its screens (the VTID is written by CI
after PLAN-SPAR converges). Staging specs sign in, navigate and read; a network guard aborts every non-GET except
sign-in; never `vitanaland.com`.
5b.5 No What's New entry (these are ports of existing screens, not new finished features — `CLAUDE.md` What's New
rule).

## R6 — Done
6.1 Every in-scope ledger row for the lane is `native` with its native route in `apps/mobile/app/` and its
functional-parity checklist (program §4 per-screen checklist) recorded; every purchase surface carries its R5 flag;
RTL (`ar`) covered.
6.2 `npm run typecheck`, `npm test`, `npm run bundle`, `npm run deps:check` and `parity-ledger --check` green (plus
`core-closure --check` and the committed generated files for a core-extracting lane); NATIVE-CI (incl. the shell
source-pin and ports checks) and the Collab handoff + Lane scope PR-GATE checks green.
6.3 `docs/validation/<VTID>/` has `scope.json` (every touched path), `staging-tests.json` (the lane's read-only spec)
and `plan-sparring.md` (copy of this plan's sparring record).

## Out of scope (named so a lane does not drift into them)
- Any screen in another Wave 2 ledger lane (`home-feed`, `events-calendar`, `media`, `ai`, `inbox-chat-calls`, etc.) —
  each is its own plan.
- Supplier onboarding screens (`CommercePortalLogin` / `CommerceJoin` / `CommercePortal`) — not in this ledger lane.
- Any change to the iOS IAP gating behaviour (this port only flags the surfaces; the gate extension is program
  decision 5, owner/store-gated).
- G1 / G2 / G3 provisioning, EAS / store build pipelines, the ORB voice module — their own plans / owner gates.
- Any web-side change beyond adding an i18n key (DE first) and a `@vitana/core` re-export line.
