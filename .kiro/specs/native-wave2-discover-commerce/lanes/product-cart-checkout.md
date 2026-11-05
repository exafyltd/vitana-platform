---
lane: product-cart-checkout
state: ready
next_actor: kiro
depends_on: [discover]
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(app)/discover/product/**
  - apps/mobile/app/(app)/universal-cart.tsx
  - apps/mobile/app/(app)/checkout/**
  - apps/mobile/app/(app)/tickets/success.tsx
  - apps/mobile/app/(app)/packages/success.tsx
  - apps/mobile/src/screens/commerce/**
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
updated: 2026-10-21T12:00Z
vtid:
---
# Product + cart + checkout port — `/discover/product/:id`, `/universal-cart`, and the success-confirmation routes
Plan: `.kiro/specs/native-wave2-discover-commerce/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: product-cart-checkout -->` (tasks 1–9) are authoritative. VTID: assigned by CI after PLAN-SPAR converges;
do not start before `vtid:` is set here. **depends_on `discover`:** this lane consumes the `AddToCartButton` native
twin that the `discover` lane owns (design decision 3) — start only after `discover` is `done`.
**Measured on the worktree (= origin/main of `exafyltd/vitana-v1`):** 5 ledger rows under
`"lane": "discover-commerce"` for this lane, all `not_started` — `DISCOVER.PRODUCT_DETAIL /discover/product/:id`,
`DISCOVER.CART /universal-cart`, and the exclusion rows `/checkout/success`, `/tickets/success`, `/packages/success`
(2 registry + 3 exclusion = 5). Web sources `src/pages/discover/ProductDetail.tsx` (public, no AuthGuard; PDP +
affiliate buy external redirect; reward-points preview), `src/pages/UniversalCart.tsx` (gated; Warenkorb/Gemerkt tabs,
quantity steppers, wallet balance card, checkout idempotency, AI propose/reorder, `AddMoneyDialog` on insufficient
balance, affiliate redirects), `src/pages/CheckoutSuccess.tsx` (`?checkout_id` cart refresh; `?deposit_id` Stripe
wallet top-up poll), `src/pages/TicketPurchaseSuccess.tsx`, `src/pages/PackagePurchaseSuccess.tsx`; routes at
`src/App.tsx:1029-1113`. Cart/checkout/wallet hooks reused natively (class B, not moved into core): `useUniversalCart`,
`useShoppingAgent`, `useMarketplaceProduct`, `GatewayWalletBalanceCard`, `AddMoneyDialog`, `useDeposit`.
**Goal.** Port the product detail page and the full purchase / confirmation flow to native on the N3 shell at 1:1
mobile-web parity: the public PDP (reward-points preview, the `AddToCartButton` twin via the port from `discover`,
affiliate external "Buy" redirect), the universal cart (tabs, quantity steppers, wallet balance, **checkout with
idempotency preserved**, AI propose/reorder, the `AddMoneyDialog` top-up on insufficient balance), and the
checkout / tickets / packages success screens (incl. the `?deposit_id` wallet-top-up return poll). **This lane carries
every highest-priority iOS-IAP-gate flag** — the cart checkout, the `AddMoneyDialog` wallet top-up, and the
`/checkout/success` deposit-return — each defaulting to TODAY'S behaviour (the shell already hides `wallet` on iOS);
the gate decision is deferred and the port changes nothing. Flips the 5 parity rows to `native`.
**Acceptance (the reviewer seat checks these):**
- Requirements R1–R6 for the five destinations; mobile-web parity; checkout idempotency preserved; `@vitana/core`-only
  web bridge; the `AddToCartButton` twin consumed via a port (not re-owned here).
- `npm run typecheck`, `npm test` (PDP loaded/not-found/error + add-to-cart + affiliate; cart quantity steppers +
  checkout idempotency + insufficient-balance → `AddMoneyDialog`; `/checkout/success` `?checkout_id` refresh +
  `?deposit_id` poll; tickets/packages success), `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (all from `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/core-closure.mjs --check` and `node scripts/native/parity-ledger.mjs --check` green with the 5
  rows `native` and their routes present in `apps/mobile/app/`; any core re-export this lane adds is committed with the
  regenerated `closure.generated.json` + `mobile-ci-paths.generated.json` in-PR (cart/checkout hooks stay native).
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form) then mirrored; RTL (`ar`) covered; no
  hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (this lane's read-only spec) and `plan-sparring.md`.
- **Commerce UX contract:** PR "UX acceptance" section present; friction unchanged; no onboarding step/field/dialog
  added; **each purchase surface carries an explicit IAP-gate note** (checkout, `AddMoneyDialog` top-up, deposit-return
  — today's behaviour, decision deferred). No class-B module moved into core.
- **Device-runtime parity (task 8)** is deferred to G1 as `next_actor: owner`; not a merge blocker, recorded in this
  log and `staging-tests.json`. The purchase-flow specs stay read-only — never complete a real checkout or wallet
  top-up against a live system.
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 5 rows), `packages/core/manifest.json`
+ closure + `src/**` (only the pure checkout/money re-exports this lane adds, if any) + `scripts/native/
mobile-ci-paths.generated.json`, `apps/mobile/src/ports/**`, `apps/mobile/src/navigation/resolve.ts`, and the DE-first
i18n shard `src/i18n/*/discoverCommerceNative.json` are shared by row/key with the other two lanes; resolve a merge
conflict by keeping both lanes' rows/keys.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only; the native app has no production profile.
## Log
### 2026-10-21T12:00Z · kiro-planner · created → ready
Lane drafted with the plan (`state: drafted` in `handoff.md`). The 5 rows and the paths were computed from the parity
ledger and `src/App.tsx` so no file belongs to two lanes; `depends_on: [discover]` because the `AddToCartButton` twin
is owned by `discover`. Next: PLAN-SPAR spars the plan; once a VTID is written here, seat `exafyltd` claims the lane
(`queue.mjs claim native-wave2-discover-commerce/product-cart-checkout --session <id>`) after `discover` is `done`.
