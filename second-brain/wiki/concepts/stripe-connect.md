# Stripe Connect Integration

> End-to-end Stripe Connect Express integration enabling creators to receive payments for paid Live Rooms, with a 90/10 revenue split (creator/platform), covering both backend APIs and frontend UI.

## Overview

Stripe Connect Express is the payment backbone for Vitana's paid Live Rooms feature. It allows creators to onboard as Stripe connected accounts and receive direct payouts when users purchase access to their live sessions. The integration spans two VTIDs: VTID-01231 (backend) and VTID-01230 (frontend).

## Revenue Model

| Room Price | Creator Share (90%) | Platform Fee (10%) |
|-----------|--------------------|--------------------|
| $9.99 | $8.99 | $1.00 |
| $19.99 | $17.99 | $2.00 |
| $49.99 | $44.99 | $5.00 |

Revenue splits are implemented via Stripe destination charges with `application_fee_amount` set to 10% of the transaction amount.

## Backend Architecture (VTID-01231)

**Status:** Ready for Deployment

### API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/v1/creators/onboard` | Start Stripe Connect Express onboarding (3 req/hr rate limit) |
| GET | `/api/v1/creators/status` | Get creator's Stripe Connect status |
| GET | `/api/v1/creators/dashboard` | Get Stripe Express dashboard login link |
| POST | `/api/v1/stripe/webhook/connect` | Handle Stripe Connect account events |
| POST | `/api/v1/live/rooms/:id/purchase` | Purchase room access (modified to use destination charges) |

### Database Schema

Columns added to `app_users` table:
- `stripe_account_id` (TEXT, UNIQUE)
- `stripe_charges_enabled` (BOOLEAN)
- `stripe_payouts_enabled` (BOOLEAN)
- `stripe_onboarded_at` (TIMESTAMPTZ)

Four RPC functions handle account creation, status updates (webhook-driven), status retrieval, and account lookup for purchases.

### Webhook Handling

The Connect webhook (`POST /api/v1/stripe/webhook/connect`) handles:
- `account.updated` -- Updates `charges_enabled` and `payouts_enabled` in the database
- `account.external_account.created` / `account.external_account.updated` -- Logged for audit

Security: Stripe signature verification via `STRIPE_CONNECT_WEBHOOK_SECRET`, raw body parsing before `express.json()`, service role token for DB writes.

### Destination Charges

The purchase endpoint was modified from direct charges to destination charges:

```typescript
// Destination charge: 90% to creator, 10% platform fee
const paymentIntent = await stripe.paymentIntents.create({
  amount: price * 100,
  currency: 'usd',
  application_fee_amount: Math.round(price * 100 * 0.10),
  transfer_data: { destination: creatorStripeAccountId },
});
```

Validation ensures the creator is onboarded (`charges_enabled = true`) before allowing purchases.

## Frontend Integration (VTID-01230)

**Status:** Complete

### Components

| Component | Purpose |
|-----------|---------|
| `useCreator.ts` | React Query hooks: `useCreatorStatus()`, `useCreatorOnboard()`, `useCreatorDashboard()` |
| `EnablePaymentsButton.tsx` | State-aware button (Not Onboarded / Partially Onboarded / Fully Onboarded) |
| `CreatorPaymentsSection.tsx` | Full payment management section for Settings > Billing page |
| `CreatorOnboarded.tsx` | Success page shown after Stripe onboarding completion |

### User Flows

**First-time creator:** Create Live Room -> Select "Paid" access -> Warning: "Payment setup required" -> Click "Enable Payments" -> Redirect to Stripe Connect onboarding -> Complete form -> Return to `/creator/onboarded` -> Success page -> Can now create paid rooms.

**Returning creator:** Settings > Billing -> Creator Payments section -> Status shows "Payments Enabled" -> "View Dashboard" opens Stripe Express dashboard.

### Integration Points

- `CreateLiveRoomDialog.tsx` -- Shows `EnablePaymentsButton` when "Paid" access selected; blocks paid room creation if `charges_enabled` is false
- `Billing.tsx` -- Added `CreatorPaymentsSection` between subscription and plans sections
- `App.tsx` -- Added `/creator/onboarded` route

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `STRIPE_SECRET_KEY` | Stripe API key (GCP Secret) |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | Webhook signing secret (GCP Secret) |
| `FRONTEND_URL` | Redirect URL base |
| `VITE_GATEWAY_BASE` | Frontend gateway base URL |

## Deployment Dependencies

1. Stripe Connect enabled in dashboard (Express mode)
2. `STRIPE_CONNECT_WEBHOOK_SECRET` in GCP Secret Manager
3. Backend APIs deployed (VTID-01231) before frontend
4. Stripe Connect webhook URL configured: `https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/stripe/webhook/connect`

## Related Pages

- [[stripe]] -- Stripe as a payment entity
- [[self-healing-system]] -- Infrastructure monitoring that could detect Stripe integration failures
- [[spec-governance]] -- Governance rules for spec compliance
- [[summary-stripe-connect]] -- Source summary of Stripe Connect specs
- [[summary-daily-co-integration]] -- Daily.co integration that Stripe Connect payments support

## Sources

- `raw/specs/VTID-01230-stripe-connect-frontend.md`
- `raw/specs/VTID-01231-stripe-connect-backend.md`

## Last Updated

2026-04-12
