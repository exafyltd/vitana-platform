# VTID-01231: Stripe Connect Express Backend

**Status**: Draft → Needs OASIS Registration
**Target Role**: DEV
**Related**: VTID-01230 (Frontend), VTID-01228 (Stripe Payments)

## Overview

Backend implementation for Stripe Connect Express to enable Live Rooms creators to receive payments directly. Platform takes 10% fee, creator receives 90%.

## Scope

### Database Layer
- Migration: Add Stripe Connect fields to `app_users` table
  - `stripe_account_id` (TEXT UNIQUE)
  - `stripe_charges_enabled` (BOOLEAN)
  - `stripe_payouts_enabled` (BOOLEAN)
  - `stripe_onboarded_at` (TIMESTAMPTZ)
- RPCs:
  - `update_user_stripe_account()` - Store account ID during onboarding
  - `update_user_stripe_status()` - Update capabilities from webhook
  - `get_user_stripe_status()` - Get current user's status
  - `get_user_stripe_account()` - Get creator's account by user_id

### Gateway Routes

**Creator Onboarding API** (`/api/v1/creators/*`)
- `POST /onboard` - Create Stripe Express account + return onboarding link
  - Rate limited: 3 attempts/hour per IP
  - Stores account ID in database
- `GET /status` - Get current user's Stripe account status
- `GET /dashboard` - Get Stripe Express dashboard link

**Connect Webhook Handler** (`/api/v1/stripe/webhook/connect`)
- Handles `account.updated` events
- Updates database with `charges_enabled` / `payouts_enabled` status
- Uses raw body parser for signature verification

**Live Purchase Endpoint Update** (`/api/v1/live/:roomId/purchase`)
- Check creator onboarding status before purchase
- Create PaymentIntent with destination charges
  - `application_fee_amount`: 10% of price
  - `transfer_data.destination`: Creator's Stripe account ID
- Return `CREATOR_NOT_ONBOARDED` error if creator not ready

### Environment Variables / Secrets
- `STRIPE_CONNECT_WEBHOOK_SECRET` (GCP Secret) - Webhook signing secret
- `FRONTEND_URL` (Config Var) - For onboarding redirect URL

## Implementation Files

### Created
- `supabase/migrations/20260209_vtid_01231_stripe_connect.sql`
- `services/gateway/src/routes/creators.ts`
- `services/gateway/src/routes/stripe-connect-webhook.ts`

### Modified
- `services/gateway/src/index.ts` - Mount new routes + raw body parser
- `services/gateway/src/routes/live.ts` - Update purchase endpoint for destination charges
- `scripts/deploy/deploy-service.sh` - Add STRIPE_CONNECT_WEBHOOK_SECRET to Gateway secrets

## Deployment Plan

### Prerequisites
1. Register VTID-01231 in OASIS ledger
2. Create `STRIPE_CONNECT_WEBHOOK_SECRET` in GCP Secret Manager
3. Run database migration via Supabase Dashboard

### Deploy Steps
```bash
cd ~/vitana-platform
cat .gcp-config  # Verify project/region
ENVIRONMENT=dev-sandbox INITIATOR=user ./scripts/deploy/deploy-service.sh gateway
```

### Post-Deploy
1. Configure Stripe Connect webhook in Stripe Dashboard:
   - URL: `https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/stripe/webhook/connect`
   - Events: `account.updated`, `account.external_account.created`, `account.external_account.updated`
2. Update `STRIPE_CONNECT_WEBHOOK_SECRET` in GCP with real webhook secret
3. Test creator onboarding flow
4. Test purchase flow with destination charges
5. Verify webhook handling

## Testing Checklist
- [ ] Creator onboarding creates Stripe Express account
- [ ] Onboarding link redirects to Stripe
- [ ] Account completion triggers webhook
- [ ] Database updates with `charges_enabled` status
- [ ] Purchase endpoint checks creator onboarding
- [ ] Destination charges created correctly (90/10 split)
- [ ] Rate limiting blocks excessive onboarding attempts
- [ ] Webhook signature verification works

## Governance Notes
- VTID-01231 is backend ONLY
- VTID-01230 is frontend UI wiring to these endpoints
- Must follow SYS-RULE-DEPLOY-L1 (canonical deploy script)
- Must register in OASIS before deployment
- Must verify immediately post-deploy (not deferred)
