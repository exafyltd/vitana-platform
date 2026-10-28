# VTID-04982 — Rewards shop backend

Owner decisions: BUSINESS-MODEL.md §11 items 6 and 8; Gate 1 approval 2026-10-08 (plan hash in plan-sparring.md).

AC-1 Event/digital items are paid in earned VTNA at once (purchased credits never count), stock is taken, and a replayed request returns the same order without a second debit.
TEST: supabase/tests/vtid_04982_rewards_shop.test.sql

AC-2 Ship items reserve one unit and move no VTNA until Stripe confirms the shipping fee; the last unit is held from other members; settling debits VTNA once and turns the hold into a stock decrement.
TEST: supabase/tests/vtid_04982_rewards_shop.test.sql

AC-3 Unpaid holds are released after 30 minutes by checkout.session.expired, by the 5-minute sweep and before each redeem of the item; a second release is a no-op; a late payment settles if stock remains, else it is refunded; a payment after the VTNA was spent elsewhere is refunded and the hold released.
TEST: supabase/tests/vtid_04982_rewards_shop.test.sql

AC-4 Age-restricted items need a birth date and confirmation; under-age is refused; only age_confirmed_at is stored, never the birth date. Shipping only to listed countries with a fee row; address required.
TEST: supabase/tests/vtid_04982_rewards_shop.test.sql

AC-5 Test/service accounts are refused; members cannot call any shop function or write the tables; the migration refuses to apply while fn_consume_credits is open to members.
TEST: services/gateway/test/vtid-04982-rewards-shop.test.ts

AC-6 Routes: member shop/orders, exafy_admin catalogue/fees/order status; prices never from the client; the Stripe Checkout charges the shipping fee only; a replay reuses the session; a failed checkout releases the hold; error codes map to HTTP statuses.
TEST: services/gateway/test/vtid-04982-rewards-shop.test.ts

AC-7 Billing webhook: reward_shipping completed -> settle (refund the Stripe charge when the SQL says so; DB errors throw so Stripe retries); checkout.session.expired -> release. OASIS: rewards.shop.redeemed / shipping_paid / refunded / reservation_expired / order_status_changed.
TEST: services/gateway/test/vtid-04982-rewards-shop.test.ts

AC-8 Staging (read-only): the new routes are mounted and answer 401 JSON without a member.
CURL: https://preview-aws-gateway.vitanaland.com/api/v1/rewards/shop

Decisions taken
- No environment switch: the shop shows nothing and nothing can be redeemed until the owner adds active items (is_active defaults to false).
- Account erasure: reward_orders has a uuid user_id and is not on the erasure_registry retain list, so erase_user_data() (VTID-04765) deletes a member's orders, address included, with no change to that function. The VTNA debits stay in wallet_transactions, as for every reward.
- The Stripe "checkout.session.expired" event must be enabled on the billing webhook endpoint before the first ship item goes live; until then the 5-minute sweep releases holds.

## Route evidence
ROUTE_MOUNT: services/gateway/src/index.ts — mountRouterSync(app, '/api/v1', rewardsShopRouter, { owner: 'rewards-shop' }) (routes/rewards-shop.ts)
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/rewards/shop (staging); production after publish: https://gateway.vitanaland.com/api/v1/rewards/shop
CURL_PROOF: `curl -s -o /dev/null -w "%{http_code} %{content_type}" https://preview-aws-gateway.vitanaland.com/api/v1/rewards/shop` → expected `401 application/json` (route mounted, member required); checked by STAGING-VERIFY from staging-tests.json and recorded here after the staging deploy.
OASIS_PROOF: services/gateway/src/types/cicd.ts adds rewards.shop.redeemed / shipping_paid / refunded / reservation_expired / order_status_changed; emitted by services/gateway/src/services/rewards/reward-shop.ts (vtid VTID-04982, source reward-shop); each emission is asserted in services/gateway/test/vtid-04982-rewards-shop.test.ts.
