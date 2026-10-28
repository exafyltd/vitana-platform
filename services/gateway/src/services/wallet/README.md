# Vitana Wallet — Stripe Deposits + Spend / Earning

VTID-03200 (schema) + VTID-03201 (gateway) + **VTID-03249 (spend + earning RPCs)**. Multi-currency (EUR primary, USD allowed). Stripe Checkout is the money-in rail; cart and Vitanaland Marketplace are the money-out and money-back-in rails respectively. The internal `wallet_ledger_entries` table is the source of truth; `wallet_accounts.balance_minor` is a cached projection.

## Cart / Marketplace integration contract (VTID-03249)

Cart and marketplace services in this gateway codebase should **import the service module directly** instead of going over HTTP:

```ts
import {
  debitWalletForSpend,
  creditWalletForEarning,
} from '../services/wallet/spend-earning-service';

// buyer-side cart checkout
const result = await debitWalletForSpend({
  account_id: buyerAccountId,
  amount_minor: 2500,
  currency: 'EUR',
  reference_type: 'cart_checkout',  // or 'marketplace_order' for marketplace
  reference_id: orderId,             // YOUR business id — drives idempotency
  description: 'Cart checkout #42',
  metadata: { items: cartLineCount },
});
if (!result.ok) {
  // 'INSUFFICIENT_BALANCE' → redirect user to top-up flow
  // 'CURRENCY_MISMATCH'    → present in the user's account currency
  // 'ACCOUNT_NOT_FOUND'    → wallet not provisioned yet (very rare; trigger missed)
  // 'ACCOUNT_NOT_ACTIVE'   → wallet frozen — do not retry
  return handle(result);
}
// result.balance_minor is the new cached balance
// result.duplicate=true means a previous call already wrote this entry; safe

// seller-side marketplace earning
const earning = await creditWalletForEarning({
  account_id: sellerAccountId,
  amount_minor: payoutAmountMinor,
  currency: 'EUR',
  reference_type: 'marketplace_earning',
  reference_id: orderId,             // same reference_id as the buyer debit is fine
  description: 'Sale #42 payout',
});
```

The `(reference_type, reference_id, entry_type)` unique constraint on `wallet_ledger_entries` makes both functions idempotent — replay the same call and you get `duplicate: true` with the current balance, no double-write. The cart/marketplace teams pick `reference_id` (their own order ID); a single business event yields one debit + one credit even if either call retries.

**Out-of-process callers** (services in other Cloud Run instances) hit the gateway:

| Endpoint | Body | Auth |
|---|---|---|
| `POST /api/v1/wallet/admin/spend` | `{account_id, amount_minor, currency, reference_type, reference_id, description?, metadata?}` | `requireExafyAdmin` |
| `POST /api/v1/wallet/admin/credit` | same shape | `requireExafyAdmin` |

HTTP status codes mirror the service: `400` invalid input, `404` ACCOUNT_NOT_FOUND, `409` INSUFFICIENT_BALANCE / CURRENCY_MISMATCH / ACCOUNT_NOT_ACTIVE, `500` GATEWAY_MISCONFIGURED / RPC_FAILED.

### Allowed `reference_type` values

`cart_checkout`, `marketplace_order`, `marketplace_earning`, `live_room_tip`, `manual`. New surfaces add their value to `SpendEarningReferenceType` + the `ALLOWED_REFERENCE_TYPES` set in `wallet-admin.ts` in the same PR.

## Architecture (one screen)

```
                              ┌──────────────────────────┐
  user clicks "Add money" ─▶  │  POST /wallet/deposits   │
                              │  /create                 │
                              └────────────┬─────────────┘
                                           │
                                           ▼
                          ┌────────────────────────────────┐
                          │  insert wallet_deposits row    │
                          │  status=created                │
                          │  generate idempotency_key      │
                          └────────────┬───────────────────┘
                                       │
                                       ▼
                          ┌────────────────────────────────┐
                          │  stripe.checkout.sessions      │
                          │  .create({...}, {              │
                          │    idempotencyKey,             │
                          │    metadata: {deposit_id,...}  │
                          │  })                            │
                          └────────────┬───────────────────┘
                                       │
                                       ▼
                          ┌────────────────────────────────┐
                          │  update deposit:               │
                          │  status=checkout_started       │
                          │  stripe_checkout_session_id    │
                          └────────────┬───────────────────┘
                                       │
                                       ▼
                            redirect to checkout_url
                                       │
                          ─ ─ ─ ─ ─ ─ ─┼─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
                                       │ user pays
                                       ▼
                          ┌────────────────────────────────┐
                          │  Stripe → POST /api/v1/stripe/ │
                          │             webhook/wallet     │
                          │  (strict signature verify)     │
                          └────────────┬───────────────────┘
                                       │
                                       ▼
                          ┌────────────────────────────────┐
                          │  insert stripe_webhook_events  │
                          │  (UNIQUE stripe_event_id —     │
                          │   replay returns 200, no work) │
                          └────────────┬───────────────────┘
                                       │
                                       ▼
                          ┌────────────────────────────────┐
                          │  credit_deposit() RPC          │
                          │   - SELECT FOR UPDATE deposit  │
                          │   - INSERT ledger entry        │
                          │     (UNIQUE prevents dup)      │
                          │   - UPDATE cached balance      │
                          │   - mark deposit succeeded     │
                          │  …all in one transaction       │
                          └────────────────────────────────┘
```

## Files

| Path | Purpose |
|---|---|
| `supabase/migrations/20260529000000_VTID_03200_wallet_stripe_deposits.sql` | Schema, trigger, RPC, backfill |
| `src/types/wallet.ts` | DTOs and the `WalletCurrency` type guard |
| `src/services/wallet/stripe-client.ts` | Lazy Stripe client + env helpers |
| `src/services/wallet/checkout-metadata.ts` | Versioned, strongly-typed Stripe metadata |
| `src/services/wallet/deposit-service.ts` | `createDeposit`, `finalizeDeposit`, `markDepositTerminal` |
| `src/services/wallet/balance-service.ts` | Read accounts + paginated ledger |
| `src/routes/wallet.ts` | User-facing routes (auth required) |
| `src/routes/wallet-stripe-webhook.ts` | Strict-signature webhook handler |
| `test/wallet-checkout-metadata.test.ts` | Metadata round-trip + version guard |
| `test/wallet-stripe-webhook.test.ts` | Signature, idempotency, dispatch |

## Environment

```
STRIPE_SECRET_KEY=sk_live_...                     # shared with creators / payments
STRIPE_WALLET_WEBHOOK_SECRET=whsec_...            # SEPARATE from connect/payments
APP_BASE_URL=https://vitanaland.com               # success/cancel redirect base
SUPABASE_URL=https://...supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...                  # service role (RLS bypass)
SUPABASE_JWT_SECRET=...                           # for user-route auth
```

Three separate webhook secrets (wallet / payments / connect) — rotate one without touching the others.

## API

All user routes require `Authorization: Bearer <supabase-jwt>`.

### POST `/api/v1/wallet/deposits/create`
```json
{ "amount_minor": 2500, "currency": "EUR" }
```
Response:
```json
{
  "ok": true,
  "deposit_id": "...",
  "checkout_url": "https://checkout.stripe.com/c/pay/...",
  "expires_at": "2026-05-29T13:30:00.000Z"
}
```
Errors: `INVALID_AMOUNT`, `INVALID_CURRENCY`, `ACCOUNT_NOT_ACTIVE`, `STRIPE_CHECKOUT_FAILED` (e.g. Stripe minimum violation).

### GET `/api/v1/wallet/deposits/:id`
Poll-after-redirect endpoint for the frontend success page. Returns `status` ∈ `created | checkout_started | succeeded | failed | canceled | expired`. Own user only.

### GET `/api/v1/wallet/balance`
```json
{
  "ok": true,
  "accounts": [
    { "currency": "EUR", "balance_minor": 12500, "status": "active", "updated_at": "..." },
    { "currency": "USD", "balance_minor": 0,      "status": "active", "updated_at": "..." }
  ]
}
```

### GET `/api/v1/wallet/transactions?currency=EUR&limit=20&cursor=<iso>`
Cursor-paginated ledger entries (most recent first).

### POST `/api/v1/stripe/webhook/wallet`
Stripe-signed. Strict verification with `STRIPE_WALLET_WEBHOOK_SECRET`. Subscribed event types:
- `checkout.session.completed` — primary credit path
- `checkout.session.expired` — mark deposit `expired`
- `checkout.session.async_payment_failed` — mark deposit `failed`
- `payment_intent.succeeded` — reconciliation path (idempotent)
- `payment_intent.payment_failed` — mark deposit `failed`

## Idempotency layers (defence in depth)

| Layer | Mechanism | Catches |
|---|---|---|
| Stripe API call | `Stripe-Idempotency-Key` header | Retried Checkout Session creates |
| Webhook entry | `stripe_webhook_events.stripe_event_id` unique | Stripe redelivery of the same event |
| Ledger write | `UNIQUE(reference_type, reference_id, entry_type)` | Two distinct events finalizing the same deposit |
| Deposit status | `wallet_deposits.status='succeeded'` early-return | Concurrent worker race |

## Local dev — Stripe CLI

```bash
# Forward Stripe events to your local gateway.
stripe listen --forward-to localhost:8787/api/v1/stripe/webhook/wallet

# Copy the printed whsec_... into STRIPE_WALLET_WEBHOOK_SECRET in .env.local.

# Trigger a fake successful checkout:
stripe trigger checkout.session.completed

# Replay the same event 5× — balance should not move after the first credit:
stripe events resend evt_xxx
```

## Sample curl

```bash
# Create deposit (EUR)
curl -X POST https://gateway.vitanaland.com/api/v1/wallet/deposits/create \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"amount_minor": 2500, "currency": "EUR"}'

# Poll deposit status after Stripe redirect
curl https://gateway.vitanaland.com/api/v1/wallet/deposits/$DEPOSIT_ID \
  -H "Authorization: Bearer $JWT"

# Read wallet balances
curl https://gateway.vitanaland.com/api/v1/wallet/balance \
  -H "Authorization: Bearer $JWT"

# Recent EUR transactions
curl "https://gateway.vitanaland.com/api/v1/wallet/transactions?currency=EUR&limit=10" \
  -H "Authorization: Bearer $JWT"
```

## Test checklist (manual + automated)

- [x] User signup → both EUR + USD accounts auto-created via `auth.users` trigger
- [x] Backfill creates accounts for existing users; idempotent on re-run
- [x] Missing `stripe-signature` → 400, no DB write *(automated)*
- [x] Invalid signature → 400, no DB write *(automated)*
- [x] Valid `checkout.session.completed` → balance credited once *(automated dispatch; RPC integration tested manually)*
- [x] Replayed `stripe_event_id` → 200, no second credit *(automated)*
- [x] Unhandled event type → 200, marked processed *(automated)*
- [x] Missing/invalid metadata → no credit attempt *(automated)*
- [x] `payment_status != 'paid'` → no credit *(automated)*
- [x] `checkout.session.expired` → deposit `expired` *(automated)*
- [x] Handler error → 500 + event marked with `processing_error` *(automated)*
- [ ] EUR credit doesn't leak into USD balance *(manual integration)*
- [ ] `€0.01` → Stripe rejects; deposit marked `failed` with reason *(manual)*
- [ ] User A cannot read User B's `/balance` or `/transactions` *(RLS test, manual)*
- [ ] `ledger.SUM(credits) - SUM(debits) = wallet_accounts.balance_minor` per account *(reconciliation invariant — schedule as ops job)*

## Out of scope (later phases)

- Withdrawals
- P2P transfers between users
- Refunds (read path only — no `refund_debit` ledger inserts yet)
- Admin manual-adjustment endpoint (`/wallet/admin/adjust`)
- Unifying with the existing `wallet_transactions` (rewards/automations) ledger
- VTNA conversion flows

## VTID hygiene

- **VTID-03200** (schema migration) and **VTID-03201** (gateway routes) are pre-picked placeholders. Per the standing rule (`feedback_vtid_collision_check_at_merge`), re-verify with `git log origin/main --grep="VTID-03200"` and `git log origin/main --grep="VTID-03201"` immediately before merge, then claim via `POST /api/v1/vtid/allocate` (EXEC-DEPLOY hard-fails on missing ledger).
