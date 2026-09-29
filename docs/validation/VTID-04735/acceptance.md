# VTID-04735 — Validate referrals server-side, at the click and at the credit

Plan step 3 of `docs/COMMERCE-SUPPLIER-INFRASTRUCTURE-ARCHITECTURE.md` (§9.2, §9.4), the part that needs no schema change. The audit found that `GET /r/:product_id` stored the client-supplied `?rec_id=` unchecked, and the recommender credit had no self-referral, product-match or test-account check.

## Change

- `services/recommendation-commissions/referral-validation.ts` is new and pure. It holds the one rule for whether a referral counts:
  - the referral exists and is active;
  - it is for the bought product;
  - the recommender is not the buyer;
  - the recommender is not a test or service account (`service_bot_accounts` ∪ `notification_test_actors`, NEVER rules 43–45).
  - `isReferralId` also rejects a non-UUID before it reaches the database.
- `routes/click-redirect.ts` gets a new `resolveClickReferral()`:
  - a referral that does not count is dropped from the click, and the reason goes on `marketplace.click.outbound` as `attribution_rejected_reason`;
  - if the lookup fails, the referral is kept as `unverified`, so the redirect never depends on the database.
- `services/recommendation-commissions/credit-recommender.ts` re-validates strictly before paying:
  - an invalid referral writes a permanent `skipped_ineligible` row with payout 0;
  - it emits `marketplace.recommendation.commission_skipped_invalid_referral` with the reason;
  - it returns `skipped_invalid_referral`;
  - no wallet credit happens.
- The repositories now select the fields the rule needs: product and buyer on the order, and product and status on the referral.

Not in this change, because they need a migration go-ahead: storing the referrer on the click, and making `product_orders.user_id` nullable for anonymous buyers.

## Acceptance criteria

AC-1: the rule accepts a valid referral (also for an anonymous buyer) and rejects not-found, disabled, other-product, self-referral and test/service-account referrals.
  TEST: services/gateway/test/services/referral-validation.test.ts
AC-2: the click drops a referral that does not count, with its reason, and drops a malformed id without a database query.
  TEST: services/gateway/test/routes/click-redirect-referral.test.ts
AC-3: a failed referral lookup keeps the click's referral as `unverified` instead of failing or silently dropping it.
  TEST: services/gateway/test/routes/click-redirect-referral.test.ts
AC-4: the credit never pays an invalid referral. It records a permanent skip with payout 0 and emits an OASIS event with the reason.
  TEST: services/gateway/test/services/credit-recommender.test.ts
AC-5: valid referrals are still credited exactly as before; the existing credit tests pass with the new fields.
  TEST: services/gateway/test/services/credit-recommender.test.ts
AC-6: on staging the click route still answers for an unknown product (read-only probe, no click is logged).
  CURL: GET https://preview-aws-gateway.vitanaland.com/r/00000000-0000-4000-8000-000000000000

## Staging

A real click writes a `product_clicks` row into the shared production database, so no click is made on staging. The staging suite probes the route for an unknown product (404, no write) and runs the suites above.

OASIS_PROOF: `marketplace.click.outbound` gains the `attribution_rejected_reason` field. The new event type `marketplace.recommendation.commission_skipped_invalid_referral` is emitted per rejected credit and asserted in `test/services/credit-recommender.test.ts`.
