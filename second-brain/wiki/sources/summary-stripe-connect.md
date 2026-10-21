# Summary: Stripe Connect Specifications

> Summary of the Stripe Connect Express frontend (VTID-01230) and backend (VTID-01231) specifications for creator payment integration.

## Source Documents

- `raw/specs/VTID-01230-stripe-connect-frontend.md` -- Frontend UI spec (Status: COMPLETE, 2026-02-09)
- `raw/specs/VTID-01231-stripe-connect-backend.md` -- Backend API spec (Status: READY FOR DEPLOYMENT, 2026-02-09)

## Backend Spec Summary (VTID-01231)

### Purpose
Enable creators to receive payments for paid Live Rooms via Stripe Connect Express with 90/10 revenue split.

### Architecture
Frontend -> Gateway API -> Supabase (database) + Stripe API (Connect)

### Endpoints Created
- `POST /api/v1/creators/onboard` -- Start onboarding (rate limited: 3/hr/IP)
- `GET /api/v1/creators/status` -- Fetch Stripe Connect status
- `GET /api/v1/creators/dashboard` -- Get Express dashboard link
- `POST /api/v1/stripe/webhook/connect` -- Handle account events

### Endpoint Modified
- `POST /api/v1/live/rooms/:id/purchase` -- Changed from direct charges to destination charges with `application_fee_amount` (10%)

### Database Changes
Four columns added to `app_users`: `stripe_account_id`, `stripe_charges_enabled`, `stripe_payouts_enabled`, `stripe_onboarded_at`. Four RPC functions created for account management.

### Files Created/Modified
- `routes/creators.ts` (NEW, 271 lines)
- `routes/stripe-connect-webhook.ts` (NEW, 163 lines)
- `routes/live.ts` (MODIFIED, ~50 lines for purchase endpoint)
- `index.ts` (MODIFIED, +5 lines for route mounting)
- Migration SQL (NEW, 95 lines)

### Security
Webhook signature verification, raw body parsing, service role for DB operations, rate limiting on onboarding.

## Frontend Spec Summary (VTID-01230)

### Purpose
Creator onboarding UI, payment status display, paid room creation integration, onboarding success experience.

### Components Created
1. **`useCreator.ts`** -- Three React Query hooks: `useCreatorStatus()`, `useCreatorOnboard()`, `useCreatorDashboard()`
2. **`EnablePaymentsButton.tsx`** -- Adaptive button showing onboarding state
3. **`CreatorPaymentsSection.tsx`** -- Full payment management for Settings > Billing
4. **`CreatorOnboarded.tsx`** -- Post-onboarding success page

### Integration Points
- `CreateLiveRoomDialog.tsx` modified to show payment setup warning for paid rooms
- `Billing.tsx` modified to include CreatorPaymentsSection
- `App.tsx` modified to add `/creator/onboarded` route

### Testing Status
9 of 11 checklist items completed. Remaining: end-to-end onboarding with real Stripe account, webhook UI reflection.

## Related Pages

- [[stripe-connect]] -- Concept page combining both specs
- [[stripe]] -- Stripe entity page
- [[summary-daily-co-integration]] -- Daily.co Live Rooms that Stripe payments support

## Sources

- `raw/specs/VTID-01230-stripe-connect-frontend.md`
- `raw/specs/VTID-01231-stripe-connect-backend.md`

## Last Updated

2026-04-12
