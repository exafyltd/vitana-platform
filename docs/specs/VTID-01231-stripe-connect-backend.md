# VTID-01231: Stripe Connect Express Backend

**Status:** READY FOR DEPLOYMENT  
**Date:** 2026-02-09  
**Owner:** Backend  
**Depends On:** VTID-01228 (Daily.co Live Rooms)  
**Related:** VTID-01230 (Frontend UI)

---

## Overview

Enable creators to receive payments for paid Live Rooms via Stripe Connect Express. Platform takes 10% fee, creators receive 90%.

### Goals
1. Creator onboarding via Stripe Express
2. Destination charges with automatic splits
3. Webhook-driven status updates
4. Secure, rate-limited APIs

---

## Architecture

```
┌─────────────────┐      ┌──────────────────┐      ┌─────────────────┐
│   Frontend      │──────│   Gateway API    │──────│   Supabase      │
│   (VTID-01230)  │      │   (VTID-01231)   │      │   (Database)    │
└─────────────────┘      └────────┬─────────┘      └─────────────────┘
                                  │
                         ┌────────┴─────────┐
                         │   Stripe API     │
                         │   (Connect)      │
                         └──────────────────┘
```

---

## Database Schema

**Migration:** `supabase/migrations/20260209_vtid_01231_stripe_connect.sql`

### Schema Changes

```sql
-- Add to app_users table
ALTER TABLE app_users ADD COLUMN stripe_account_id TEXT UNIQUE;
ALTER TABLE app_users ADD COLUMN stripe_charges_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE app_users ADD COLUMN stripe_payouts_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE app_users ADD COLUMN stripe_onboarded_at TIMESTAMPTZ;

-- Index for lookups
CREATE INDEX idx_app_users_stripe_account 
  ON app_users(stripe_account_id) WHERE stripe_account_id IS NOT NULL;
```

### RPC Functions

| Function | Purpose | Auth |
|----------|---------|------|
| `update_user_stripe_account(p_stripe_account_id)` | Store account ID during onboarding | User JWT |
| `update_user_stripe_status(p_stripe_account_id, p_charges_enabled, p_payouts_enabled)` | Webhook updates status | Service Role |
| `get_user_stripe_status()` | Get current user's status | User JWT |
| `get_user_stripe_account(p_user_id)` | Get creator's account for purchase | Service Role |

---

## API Endpoints

### Creator Onboarding

#### `POST /api/v1/creators/onboard`

Start Stripe Connect Express onboarding.

**Rate Limit:** 3 requests/hour/IP

**Request:**
```json
{
  "return_url": "https://vitana.io/creator/onboarded",
  "refresh_url": "https://vitana.io/creator/onboard"
}
```

**Response:**
```json
{
  "ok": true,
  "onboarding_url": "https://connect.stripe.com/...",
  "account_id": "acct_xxxx"
}
```

**Flow:**
1. Check if user already has Stripe account
2. If exists, generate new onboarding link
3. If not, create Express account + store ID
4. Return Stripe-hosted onboarding URL

---

#### `GET /api/v1/creators/status`

Get creator's Stripe Connect status.

**Response:**
```json
{
  "ok": true,
  "stripe_account_id": "acct_xxxx",
  "charges_enabled": true,
  "payouts_enabled": true,
  "onboarded_at": "2026-02-09T12:00:00Z"
}
```

---

#### `GET /api/v1/creators/dashboard`

Get Stripe Express dashboard login link.

**Response:**
```json
{
  "ok": true,
  "dashboard_url": "https://connect.stripe.com/express/..."
}
```

---

### Stripe Webhook

#### `POST /api/v1/stripe/webhook/connect`

Handle Stripe Connect account events.

**Headers:** `stripe-signature` (required)

**Events Handled:**

| Event | Action |
|-------|--------|
| `account.updated` | Update `charges_enabled`, `payouts_enabled` in DB |
| `account.external_account.created` | Log for audit |
| `account.external_account.updated` | Log for audit |

**Security:**
- Signature verification via `STRIPE_CONNECT_WEBHOOK_SECRET`
- Uses Service Role for DB updates (no user JWT)
- Raw body parsing (before `express.json()`)

---

### Updated Purchase Endpoint

#### `POST /api/v1/live/rooms/:id/purchase` (Modified)

Now uses destination charges instead of direct PaymentIntent.

**Changes from VTID-01228:**
```typescript
// OLD: Direct charge to platform
const paymentIntent = await stripe.paymentIntents.create({
  amount: price * 100,
  currency: 'usd',
});

// NEW: Destination charge (90% creator, 10% platform)
const paymentIntent = await stripe.paymentIntents.create({
  amount: price * 100,
  currency: 'usd',
  application_fee_amount: Math.round(price * 100 * 0.10),
  transfer_data: {
    destination: creatorStripeAccountId,
  },
});
```

**Validation:**
- Creator must be onboarded (`charges_enabled = true`)
- Returns `CREATOR_NOT_ONBOARDED` error if not ready

---

## Environment Variables

| Variable | Source | Description |
|----------|--------|-------------|
| `STRIPE_SECRET_KEY` | GCP Secret | Stripe API key |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | GCP Secret | Webhook signing secret |
| `FRONTEND_URL` | Env var | Redirect URL base |
| `SUPABASE_SERVICE_ROLE` | GCP Secret | For webhook DB updates |

---

## Security

### Rate Limiting
- `/creators/onboard`: 3 requests/hour/IP
- Prevents Stripe account creation abuse

### Webhook Security
- Signature verification with `stripe.webhooks.constructEvent()`
- Raw body parsing before JSON middleware
- Service role token for DB operations

### Access Control
- User JWT required for creator API endpoints
- Purchase validates creator is onboarded
- Daily.co URL only returned after successful payment

---

## Files Created/Modified

| File | Action | Lines |
|------|--------|-------|
| `routes/creators.ts` | NEW | 271 |
| `routes/stripe-connect-webhook.ts` | NEW | 163 |
| `routes/live.ts` | MODIFIED | ~50 (purchase endpoint) |
| `index.ts` | MODIFIED | +5 (route mounting, raw body) |
| `migrations/20260209_vtid_01231_stripe_connect.sql` | NEW | 95 |

---

## Deployment

### Prerequisites
1. Stripe Connect enabled in dashboard (Express mode)
2. `STRIPE_CONNECT_WEBHOOK_SECRET` in GCP Secret Manager

### Steps
```bash
# 1. Run migration
supabase db push

# 2. Deploy Gateway
ENVIRONMENT=dev-sandbox ./scripts/deploy/deploy-service.sh gateway

# 3. Configure Stripe webhook
# URL: https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/stripe/webhook/connect
# Events: account.updated, account.external_account.*
```

---

## Testing

### Creator Onboarding
```bash
# Start onboarding
curl -X POST https://gateway.../api/v1/creators/onboard \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json"

# Check status
curl https://gateway.../api/v1/creators/status \
  -H "Authorization: Bearer $JWT"
```

### Webhook (Stripe CLI)
```bash
stripe listen --forward-to localhost:8080/api/v1/stripe/webhook/connect
stripe trigger account.updated
```

### Purchase Flow
```bash
# Attempt purchase (creator must be onboarded)
curl -X POST https://gateway.../api/v1/live/rooms/{id}/purchase \
  -H "Authorization: Bearer $JWT"
```

---

## Revenue Model

| Price | Creator (90%) | Platform (10%) |
|-------|---------------|----------------|
| $9.99 | $8.99 | $1.00 |
| $19.99 | $17.99 | $2.00 |
| $49.99 | $44.99 | $5.00 |

---

## Monitoring

### Cloud Logging Queries
```
# Connect webhook events
resource.type="cloud_run_revision"
textPayload=~"Connect Webhook"

# Creator onboarding
resource.type="cloud_run_revision"  
textPayload=~"Creator Onboard"
```

### OASIS Events
- `live.purchase.initiated` - Payment started
- `live.purchase.completed` - Payment succeeded (webhook)

---

## Rollback

If issues arise:
1. Disable Stripe webhook in dashboard
2. Redeploy previous Gateway revision
3. Migration is additive (no data loss on rollback)
