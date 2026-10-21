# VTID-05035 — Rewards shop admin (gateway): photo upload, shipping-fee list/delete, image bucket

Owner decision 2026-10-10 (Gate 1 approval, plan hash in plan-sparring.md). This VTID is the gateway part of the plan (items 1–5); the admin screen in vitana-v1 is a separate change.

AC-1 POST /api/v1/admin/rewards/items/image, GET /api/v1/admin/rewards/shipping-fees and DELETE /api/v1/admin/rewards/shipping-fees/:country/:currency answer 401 without a signed-in user and 403 for a member who is not exafy_admin; nothing is stored, read or deleted in either case.
TEST: services/gateway/test/vtid-05035-reward-shop-admin.test.ts

AC-2 The photo upload accepts image/jpeg, image/png and image/webp only, identified by magic bytes (JPEG FF D8 FF; PNG 89 50 4E 47 0D 0A 1A 0A; WebP RIFF....WEBP); the declared content_type must match the detected type; anything else, non-image bytes or non-base64 text is 400 IMAGE_TYPE_NOT_ALLOWED; missing data is 400 ARGS_REQUIRED.
TEST: services/gateway/test/vtid-05035-reward-shop-admin.test.ts

AC-3 A decoded photo over 1.4 MB (1,468,006 bytes) is refused with 413 {ok:false, error:'IMAGE_TOO_LARGE'} before any storage call; exactly 1.4 MB is accepted.
TEST: services/gateway/test/vtid-05035-reward-shop-admin.test.ts

AC-4 An accepted photo is stored through the storage abstraction (storageUpload / storagePublicUrl) in bucket reward-shop-images under items/<uuid>.<jpg|png|webp>, with the detected content type, no upsert and a long cache lifetime; the route returns {ok:true, url, path}; a storage error (returned or thrown) is 500 IMAGE_UPLOAD_FAILED.
TEST: services/gateway/test/vtid-05035-reward-shop-admin.test.ts

AC-5 GET /api/v1/admin/rewards/shipping-fees returns every reward_shipping_fees row ordered by country, then currency; a read error is 500 FEES_READ_FAILED.
TEST: services/gateway/test/vtid-05035-reward-shop-admin.test.ts

AC-6 DELETE /api/v1/admin/rewards/shipping-fees/:country/:currency accepts only an upper-case two-letter country and EUR|USD (else 400 ARGS_REQUIRED, no database call), removes that one row and returns {ok:true}; a database error is reported as 400 FEE_REJECTED.
TEST: services/gateway/test/vtid-05035-reward-shop-admin.test.ts

AC-7 Existing shop routes keep their contract (member shop/redeem/orders, admin items/fees PUT, order status PATCH).
TEST: services/gateway/test/vtid-04982-rewards-shop.test.ts

AC-8 Migration 20261010160000_vtid_05035_reward_shop_images_bucket.sql creates the public bucket reward-shop-images (1,468,006-byte limit, image/jpeg|png|webp), adds no storage.objects policy for anon/authenticated, applies twice without error and raises if the bucket is missing or not public. Applied to a throwaway local Postgres with a stub storage.buckets table (see commands.log), never to a live database.
TEST: services/gateway/test/vtid-05035-reward-shop-admin.test.ts (routes); SQL checked locally as recorded in commands.log

AC-9 Staging (read-only): the new routes are mounted and answer 401 JSON without a signed-in user.
CURL: https://preview-aws-gateway.vitanaland.com/api/v1/admin/rewards/shipping-fees

Decisions taken
- Bucket size limit is 1.4 MB (1,468,006 bytes), not the 5 MB written in plan item 3: the plan's own round-1 answer to F3 caps the decoded image at 1.4 MB, so the bucket enforces the same cap as the route.
- The oversize check runs on the base64 length before decoding as well as on the decoded size, so an oversize body is refused without allocating its buffer.
- Photo paths are a fresh random UUID per upload and never overwritten (upsert false), so the public URL can be cached for a year (cacheControl 31536000). Replaced photos are not deleted from the bucket by this change (no delete route was in the plan).
- Staging also probes POST image and DELETE fee with invalid credentials (rejected_probe, expect 401): rejected by the auth gate before any handler runs, so nothing is written.

## Route evidence
ROUTE_MOUNT: services/gateway/src/index.ts — mountRouterSync(app, '/api/v1', rewardsShopRouter, { owner: 'rewards-shop' }) (routes/rewards-shop.ts); the three new routes are added to that existing router, no new mount.
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/admin/rewards/shipping-fees, https://preview-aws-gateway.vitanaland.com/api/v1/admin/rewards/items/image (POST), https://preview-aws-gateway.vitanaland.com/api/v1/admin/rewards/shipping-fees/:country/:currency (DELETE) (staging); production after publish: https://gateway.vitanaland.com/api/v1/admin/rewards/shipping-fees and the same paths.
CURL_PROOF: `curl -s -o /dev/null -w "%{http_code} %{content_type}" https://preview-aws-gateway.vitanaland.com/api/v1/admin/rewards/shipping-fees` → expected `401 application/json` (route mounted, sign-in required); checked by STAGING-VERIFY from staging-tests.json and recorded here after the staging deploy.
OASIS_PROOF: not applicable — no new OASIS topic. The POST image and DELETE fee handlers carry `// impact-allow-no-oasis` (photo storage before any item change; fee configuration, same category as the existing PUT /admin/rewards/shipping-fees), checked by scripts/ci/impact-rules/new-mutation-without-oasis-emit.mjs.
