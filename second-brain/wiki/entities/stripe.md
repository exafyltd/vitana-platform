# Stripe

> Third-party payment platform used by Vitana for creator payouts (Stripe Connect Express), room access purchases (Payment Intents), and webhook-driven status management.

## Overview

Stripe is Vitana's payment integration partner, providing the infrastructure for monetized Live Rooms. The integration uses Stripe Connect Express to enable a marketplace model where creators host paid sessions and receive direct payouts, with the platform collecting a 10% fee.

## Stripe Products Used

### Stripe Connect Express

Connect Express is the primary integration mode. It provides:
- **Hosted onboarding** -- Creators are redirected to Stripe's hosted onboarding flow; Vitana does not handle sensitive financial data
- **Express dashboard** -- Creators manage their payouts, tax forms, and banking details through Stripe's hosted dashboard
- **Destination charges** -- Payments are collected by the platform and automatically split to the creator's connected account
- **Webhook-driven updates** -- Account status changes (`charges_enabled`, `payouts_enabled`) are pushed to Vitana via webhooks

### Payment Intents

Used for room access purchases. The purchase flow creates a PaymentIntent with:
- `amount`: Room price in cents
- `currency`: USD
- `application_fee_amount`: 10% platform fee
- `transfer_data.destination`: Creator's Stripe account ID

The frontend receives a `client_secret` to complete payment using Stripe Elements or redirect.

## Integration Points

### Backend (VTID-01231)

| Endpoint | Stripe API Used |
|----------|----------------|
| `POST /api/v1/creators/onboard` | `stripe.accounts.create()` (type: express) + `stripe.accountLinks.create()` |
| `GET /api/v1/creators/status` | Database lookup (webhook-updated) |
| `GET /api/v1/creators/dashboard` | `stripe.accounts.createLoginLink()` |
| `POST /api/v1/stripe/webhook/connect` | `stripe.webhooks.constructEvent()` for signature verification |
| `POST /api/v1/live/rooms/:id/purchase` | `stripe.paymentIntents.create()` with destination charge |

### Frontend (VTID-01230)

- `useCreatorOnboard()` hook initiates onboarding redirect
- `useCreatorStatus()` hook polls backend for webhook-updated status
- `EnablePaymentsButton` component adapts UI to onboarding state
- `CreatorOnboarded` page handles return from Stripe onboarding

### Webhook Events

| Event | Action |
|-------|--------|
| `account.updated` | Update `charges_enabled`, `payouts_enabled` in `app_users` |
| `account.external_account.created` | Audit log |
| `account.external_account.updated` | Audit log |

## Environment & Security

| Secret | Storage | Purpose |
|--------|---------|---------|
| `STRIPE_SECRET_KEY` | GCP Secret Manager | API authentication |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | GCP Secret Manager | Webhook signature verification |

Security measures:
- Webhook signature verification via `stripe.webhooks.constructEvent()`
- Raw body parsing before JSON middleware (required for signature verification)
- Service role token for database updates (no user JWT in webhook handler)
- Rate limiting on onboarding endpoint (3 requests/hour/IP)

## Revenue Model

| Room Price | Creator (90%) | Platform (10%) |
|-----------|--------------|----------------|
| $9.99 | $8.99 | $1.00 |
| $19.99 | $17.99 | $2.00 |
| $49.99 | $44.99 | $5.00 |

## Database Footprint

Columns on `app_users` table:
- `stripe_account_id` (TEXT, UNIQUE, indexed)
- `stripe_charges_enabled` (BOOLEAN, default false)
- `stripe_payouts_enabled` (BOOLEAN, default false)
- `stripe_onboarded_at` (TIMESTAMPTZ)

## Monitoring

### OASIS Events
- `live.purchase.initiated` -- Payment started
- `live.purchase.completed` -- Payment succeeded (webhook)

### Cloud Logging Queries
- Connect webhook events: `textPayload=~"Connect Webhook"`
- Creator onboarding: `textPayload=~"Creator Onboard"`

### Success Metrics
- Percentage of creators who complete onboarding
- Time to first paid room creation
- Creator retention (month-over-month active creators)

## Rollback Plan

If issues arise with the Stripe integration:
1. Disable Stripe webhook in Stripe dashboard
2. Redeploy previous Gateway revision
3. Migration is additive (no data loss on rollback)

## Related Pages

- [[stripe-connect]] -- Detailed integration concept page
- [[self-healing-system]] -- Could detect Stripe endpoint failures
- [[summary-stripe-connect]] -- Source summary
- [[summary-daily-co-integration]] -- Live Rooms feature that Stripe payments support

## Sources

- `raw/specs/VTID-01230-stripe-connect-frontend.md`
- `raw/specs/VTID-01231-stripe-connect-backend.md`

## Last Updated

2026-04-12
