# VTID-04740 — Referrer on the click; signed-out buyers attributable

This is plan step 3b of `docs/COMMERCE-SUPPLIER-INFRASTRUCTURE-ARCHITECTURE.md` (§9.2). The owner approved the migration in session on 2026-09-29.

## Change

- Migration `supabase/migrations/20260929120000_vtid_04740_referrer_on_click_anonymous_buyers.sql`:
  - `product_clicks.referrer_user_id` and `product_clicks.attribution_rejected_reason`;
  - partial index `idx_product_clicks_referrer`;
  - `product_orders.user_id` is now nullable.
- `routes/click-redirect.ts`:
  - `resolveClickReferral()` also returns the recommender;
  - the click row stores `referrer_user_id` and `attribution_rejected_reason`.

  A later change to the referral row therefore cannot re-attribute a past click.
- Buyers usually reach a partner without a Vitana session. With `user_id NOT NULL`, the Awin sync's order upsert for such a click failed, so the sale could not be attributed. RLS compares `user_id = auth.uid()`, and NULL never matches, so no row becomes newly visible.

## Acceptance criteria

AC-1: a valid referral puts the recommender on the click; a dropped or unverified one leaves it empty with the reason.
  TEST: services/gateway/test/routes/click-redirect-referral.test.ts
AC-2: the schema is live. Both columns and the index exist and `product_orders.user_id` is nullable (checked read-only after applying, see `outputs/live-schema.txt`).
  TEST: services/gateway/test/routes/click-redirect-referral.test.ts
AC-4: a signed-out buyer's order is recorded with no user and no tenant, and its referral is still credited. `product_orders.tenant_id` is nullable, via migration `20260929120200_vtid_04740_product_orders_tenant_nullable.sql`, applied live with the owner's go-ahead after the Codex review of #3820 (see `outputs/live-schema.txt`).
  TEST: services/gateway/test/services/awin-order-sync.test.ts
AC-5: the referrer frozen on the click is the payee (wallet, commission row and self-referral check); orders without a click fall back to the recommendation owner; a failed click lookup pays nothing.
  TEST: services/gateway/test/services/credit-recommender.test.ts
AC-3: the click route still answers on staging (read-only probe, unknown product, no row written).
  CURL: GET https://preview-aws-gateway.vitanaland.com/r/00000000-0000-4000-8000-000000000000

## Staging

A real click writes into the shared production database, so no click is made on staging. The staging suite probes the route and runs the tests.

OASIS_PROOF: no new event type; the click event already carries `attribution_rejected_reason` (VTID-04735).
