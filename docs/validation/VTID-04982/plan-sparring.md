# VTID-04982 — plan sparring record (Rewards shop, backend; app is VTID-04983)

Partner: plan-sparring-partner agent (read-only). Class: standard. Rounds: 3. Verdict: CONVERGED.
Owner approval: 2026-10-08, Gate 1 "Approve (Recommended)" — plan hash c18ccb33e948bad622fbbd1552afb49d892eb3b5575a05aad0da048d4f9be925.

# Plan — VTNA Rewards Shop in the Wallet (Rewards Phase 4)

<!-- plan:begin -->
## Change class
standard (migrations, new gateway routes, a Stripe webhook branch, a new frontend tab; two repos)

## Owner decisions this implements (not re-argued)
- BUSINESS-MODEL.md §11 item 8: a Rewards Shop (MAXINA merch, Son Amaret Chardonnay MAXINA
  Edition, services, event tickets, constantly updated) prices items in VTNA with the EUR/USD
  equivalent per the member's currency setting; wine: the member confirms their age and pays
  shipping; the screen lives in the Wallet at `/wallet/rewards`.
- Item 6 / backend.md §13c rule 8: only earned VTNA is spent, through `credit_wallet()`; no
  fifth wallet; 1 VTNA = EUR 0.01.

## What already exists and is reused (verified 2026-10-08; nothing equivalent is built or in an open PR)
- Ledger: `user_wallets.earned_balance` + `credit_wallet(..., p_type 'reward', negative amount)`
  debits the earned bucket, idempotent by `p_source_event_id`, returns INSUFFICIENT_BALANCE
  (`20261001180000_vtid_04809_vtna_reward_ledger.sql:83-206`). No shop spend path exists.
- Catalogue: `merchants` / `products` (VTID-02000) were considered and are NOT used for shop items:
  `products` is read by 20+ gateway query sites (Discover, ORB marketplace tools, shopping agent,
  recommendation engine, checkout, partner review), so a VTNA item there would leak into every one
  unless each is filtered, and `affiliate_url` is NOT NULL. Rewards items are a first-party VTNA
  catalogue, not supplier offerings, so they get their own table that nothing else reads.
- `GET /api/v1/wallet/reward-rules` already returns `earned_balance` and `eur_per_vtna`
  (`routes/wallet.ts:179`); frontend `useDisplayCurrency` + `useEurUsdRate` show EUR/USD.
- Stripe: the gateway already creates Checkout sessions (`routes/billing.ts`,
  `services/wallet/deposit-service.ts`) and verifies webhooks (`payments-stripe-webhook.ts`).
- Not reused, with reason: `product_orders` (affiliate attribution states, no fulfilment or
  address), `universal_carts` (cash-only, `item_type` two values, rejects mixed currency),
  `rewards_ledger`/`user_reward_link` (VCAOP commissions, "do not extend"), `vouchers` (legacy
  event gift vouchers), `products_catalog` (dead).
- Prerequisite, separate plan: `fn_consume_credits` lockdown (members can currently call it on
  another member's earned VTNA). The shop does not ship before that fix is applied.

## Scope — two VTIDs
### A. Backend (vitana-platform)
1. Migration:
   - `reward_shop_items`: id, slug unique, `titles jsonb` and `descriptions jsonb` keyed by locale
     (`{"de": …, "en": …}`; DE required, EN fallback) — item text is data the owner/admin writes,
     not compiled i18n catalogue keys, so adding an item never needs a deploy; images text[], vtna_price integer CHECK (> 0), fulfilment
     CHECK IN ('ship','event','digital'), age_restricted boolean, min_age smallint,
     ships_to_countries char(2)[], stock integer (NULL = unlimited), reserved integer default 0,
     is_active, sort_order, timestamps. RLS: authenticated may SELECT active rows; only
     service_role writes. Not referenced by any Discover/marketplace code, so rewards items never
     appear as marketplace offerings and never influence ranking.
   - `reward_shipping_fees`: country char(2), currency, fee_cents — one row per destination.
   - `reward_orders`: id, user_id, tenant_id, product_id, vtna_amount, status
     (`awaiting_shipping_payment` | `paid` | `fulfilling` | `shipped` | `delivered` | `cancelled` |
     `refunded`), shipping_address jsonb (ship items only), shipping_fee_cents + shipping_currency,
     stripe_session_id, age_confirmed_at (no birth date is stored: it is checked and discarded),
     reservation_expires_at, idempotency_key unique, timestamps. RLS: a member reads only their own
     rows; no member writes. `erase_user_data` (VTID-04765) is extended to null shipping_address on
     a member's reward_orders.
   - `redeem_reward_item(p_tenant, p_user, p_item, p_idempotency_key, p_address, p_birth_date)`
     SECURITY DEFINER, service_role only. Under a per-member advisory lock and `SELECT … FOR
     UPDATE` on the item row: item active; test/service accounts refused (same exclusion as
     `claim_capped_reward`); age checked from p_birth_date when age_restricted (date not stored);
     destination in ships_to_countries for ship items; stock - reserved > 0, else OUT_OF_STOCK;
     earned_balance >= vtna_price, else INSUFFICIENT_BALANCE.
     Non-ship items: `credit_wallet(..., -vtna_price, 'reward', 'reward_shop',
     'reward_shop:<order id>')`, stock decremented, order `paid` — one transaction.
     Ship items: one unit RESERVED (reserved + 1), order `awaiting_shipping_payment` with
     reservation_expires_at = now() + 30 min (the Stripe session's expiry); no VTNA moves yet.
   - `settle_reward_order_shipping(p_order, p_session)` service_role only, row-locked: on Stripe
     payment debits VTNA via `credit_wallet` (key `reward_shop:<order id>`), converts the
     reservation into a stock decrement, sets `paid`. If the debit fails (VTNA spent elsewhere in
     the meantime) the reservation is released, the order goes `refunded` and the gateway refunds
     the Stripe charge. A payment that lands after the reservation was already released re-checks
     stock under the row lock; if none is left the order goes `refunded` and is refunded.
   - `release_reward_reservation(p_order)`: a no-op unless the order is still
     `awaiting_shipping_payment` (first call moves it to `cancelled` and releases, any repeat does
     nothing), so the Stripe event and the sweep can both call it safely.
   - `release_expired_reward_reservations()` service_role only: releases every
     `awaiting_shipping_payment` order whose `reservation_expires_at < now()` (indexed), each
     through `release_reward_reservation`. `redeem_reward_item` also calls it for its item before
     the stock check, so an expired hold never blocks the next member.
   - Migration self-check: raises if `fn_consume_credits` (or any function in this migration) is
     executable by authenticated or anon — so the shop cannot be applied before the lockdown.
2. Gateway routes (requireAuth; amounts never from the client):
   - `GET /api/v1/rewards/shop` — active items with vtna_price, EUR equivalent, availability,
     age_restricted, fulfilment; the member's earned_balance.
   - `POST /api/v1/rewards/shop/redeem` — body: product_id, idempotency_key, address (ship),
     birth_date + age confirmation (age items). Ship items return a Stripe Checkout URL for the
     shipping fee (flat fee per destination country from a config table row, EUR/USD per member
     currency); others return the paid order.
   - `GET /api/v1/rewards/orders` — the member's orders.
   - Stripe: the shipping-fee Checkout session is created like the credit packs in
     `routes/billing.ts` (same Stripe account and webhook endpoint) with
     `metadata.vitana_kind='reward_shipping'` and `vitana_order_id`; `handleCheckoutCompleted`
     (billing.ts ~858, which already switches on `vitana_kind`) gets a `reward_shipping` branch, and
     a `checkout.session.expired` case releases the reservation. No new Stripe endpoint; the
     existing endpoint's enabled events gain `checkout.session.expired` (one Stripe Dashboard/API
     setting, done and checked read-only via the Stripe API before the shop is switched on).
   - Reservation sweep independent of Stripe: `startRewardReservationSweep()` in the gateway,
     every 5 minutes, calls `release_expired_reward_reservations()` (same in-process loop pattern
     as `reward-sweep-runner.ts`, ECS-only), emits `rewards.shop.reservation_expired` per release.
   - Admin (exafy_admin): `GET/PATCH /api/v1/admin/rewards/orders` to move fulfilment status and
     `GET/PUT /api/v1/admin/rewards/items` to manage items; no new admin screen in this phase.
   - Routes live in a new `routes/rewards-shop.ts` under `/api/v1/rewards/*` (the existing
     `rewards-sweep.ts` prefix) and get a domain-atlas entry; no `/api/v1/wallet/*` route is added.
   - OASIS events: `rewards.shop.redeemed`, `rewards.shop.shipping_paid`,
     `rewards.shop.order_status_changed`, `rewards.shop.refunded`.
3. Tests: SQL tests (redeem paid/ship, double-submit idempotent, insufficient balance, last unit
   reserved by one member and refused to the next, reservation released on expiry, settle after
   balance spent -> refunded, age refused/accepted and no birth date stored, test account
   refused, member cannot execute, erase_user_data clears the address), wired into CI like
   `scripts/ci/test-vtid-04878-capped-rewards.sh`; gateway Jest for routes, the billing webhook
   branch (paid / refund / expired / payment after release), the reservation sweep (expired hold
   released once even when the Stripe event also arrives) and that no amount is taken from the
   client.

### B. Frontend (vitana-v1)
- No new frontend route (the Frontend NEVER rule 26 "Never add new Wallet routes"): the shop is a
  tab inside the existing `/wallet/rewards` page (App.tsx:1566), as the owner decided.
- `/wallet/rewards` gets a "Shop" tab (first tab after the rules) listing items: image, title,
  VTNA price, ≈ EUR/USD per `useDisplayCurrency`, "you have X VTNA"; disabled with the shortfall
  when the member cannot afford it. The two mock tabs (pending, referral; hardcoded data) are
  removed — they show fake numbers.
- Item sheet: description; age items ask for birth date + "I confirm I am of legal drinking age";
  ship items collect the address and show the shipping fee, then go to Stripe Checkout; return
  page shows the order. "My orders" list under the shop.
- i18n DE first, EN, then the other locales `_pending_review`; RTL logical properties; What's New
  entry; nav registry entry for the shop tab if it is a separate route (it is not: tab only).
- Vitest for the components; read-only staging Playwright spec (signs in, opens the Shop tab,
  sees items and prices, no redeem).

## Rollout
Lockdown fix first. Then A: PR -> CI -> merge -> RUN-MIGRATION -> staging -> STAGING-VERIFY ->
Gate 2. Then B the same way. The shop shows nothing until the owner adds items (title, image,
VTNA price, shipping countries and fee); launch items need the owner's prices.

## Risks
- Real goods for VTNA: abuse limited by earned-only, idempotency, per-member lock, test-account
  exclusion, and stock.
- Shipping is paid before VTNA is debited, so a member never loses VTNA for an unpaid order; a
  balance spent elsewhere between checkout and payment triggers an automatic refund.
- Alcohol: age is a self-declared birth date (checked, not stored) + confirmation, with the
  confirmation time stored on the order; shipping limited to the item's `ships_to_countries`. Legal check of per-country alcohol shipping is the owner's.
- Staging shares the production database: staging tests are read-only; redeem is proven by SQL
  and Jest tests only.
<!-- plan:end -->

## Open inputs for the owner (Gate 1)
- Launch items with VTNA prices, images, shipping countries and shipping fee per country.

## Planner responses (round 1)
- F1 blocker (NEVER rule 26 "Never add new Wallet routes"): REJECTED as a conflict, with the plan made explicit. Rule 26 sits in CLAUDE.md's "Frontend & UX" NEVER block (CLAUDE.md:250-257), i.e. app routes. The plan adds no app route: the shop is a tab inside the existing `/wallet/rewards` page (App.tsx:1566), which is exactly where the owner decided it lives (BUSINESS-MODEL.md §11 item 8: "the existing /wallet/rewards subscreen"). Gateway routes are under `/api/v1/rewards/*` in a new routes/rewards-shop.ts; no `/api/v1/wallet/*` route is added. Both statements are now in the plan. If you still read rule 26 as covering this, say so and it goes to the owner at Gate 1.
- F2 major (no gate stops the shop shipping before the lockdown): ACCEPTED — the shop migration's self-check raises if fn_consume_credits (or any of its own functions) is executable by authenticated/anon, so it cannot be applied first.
- F3 major (stock race for ship items): ACCEPTED, option (a) — one unit is reserved at redeem under FOR UPDATE, converted to a decrement on payment, released on expiry or on a failed settle.
- F4 major (which webhook): ACCEPTED — billing.ts's existing checkout.session.completed handler, which already switches on metadata.vitana_kind (billing.ts ~858); new 'reward_shipping' branch plus checkout.session.expired; same Stripe endpoint, nothing new configured.
- F5 minor (Discover call sites unnamed): ACCEPTED differently — products is read by 20+ gateway sites, so filtering each is the risky option. Shop items move to their own reward_shop_items table that no Discover/marketplace code reads.
- F6 minor (GDPR): ACCEPTED — the birth date is checked and discarded (only age_confirmed_at is stored); erase_user_data (VTID-04765) is extended to clear shipping_address on reward_orders.
- F7 minor (products.affiliate_url NOT NULL): ACCEPTED — moot, items are no longer products rows.
- Q1: see F1. Q2: the lockdown plan is written and in sparring now; it ships first and the shop migration enforces that. Q3: prevent overselling (reserve at redeem).

## Planner responses (round 2)
- F8 major (checkout.session.expired must be enabled on the Stripe endpoint): ACCEPTED — stated in Work A2; enabled and checked read-only through the Stripe API before the shop is switched on.
- F9 major (no cleanup if Stripe never fires): ACCEPTED — release_expired_reward_reservations() runs every 5 minutes from a gateway loop (reward-sweep-runner pattern) and inside every redeem for that item; OASIS rewards.shop.reservation_expired.
- F10 minor (double release): ACCEPTED — release_reward_reservation is a no-op unless the order is still awaiting_shipping_payment. Also covered: a payment that lands after release re-checks stock and refunds if none is left.
- F11 minor (title_key naming): ACCEPTED — titles/descriptions are jsonb per locale stored on the row (admin data, no deploy per item).
- Q1: a TTL sweep was missing; it is now in the plan. Q2: freeform DB strings per locale.

## Round 3 (partner)
F1-F11 closed; no new findings.

## Verdict
CONVERGED after 3 rounds (standard class). Plan hash: c18ccb33e948bad622fbbd1552afb49d892eb3b5575a05aad0da048d4f9be925
