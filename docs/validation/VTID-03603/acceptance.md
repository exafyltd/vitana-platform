# VTID-03603 — Acceptance (Shopify OAuth connector, Track 2 of the merchant-onboarding follow-up)

Scope of THIS PR: gateway-only (`services/gateway/src/**` + `prisma/migrations/**`
+ this evidence pack). New `partner_oauth_credential` table (migration
`20260811_vcaop_shopify_oauth_0006`, applied to Supabase before this PR
opened), a new `POST /connections/:id/shopify/authorize` on the existing
owner-scoped merchant router, and a new public `GET /callback` router at
`/api/v1/vcaop/shopify-oauth`. Dormant until `SHOPIFY_CLIENT_ID` +
`SHOPIFY_CLIENT_SECRET` + `SHOPIFY_OAUTH_REDIRECT_URI` are all set — no real
Shopify Partner app credentials exist in this session, so none of this can
run for real yet. Companion vitana-v1 frontend PR wires a "Connect Shopify"
button into the connect dialog.

Verification tokens: TEST = jest suite (`services/gateway/test/services/
shopify-oauth.test.ts`, `services/gateway/test/routes/shopify-oauth-callback.
test.ts`, `services/gateway/test/routes/vcaop-portal-my.test.ts`, captured in
./outputs/shopify-oauth-tests.txt).

AC-1 — The connector is fully dormant without all required env vars, on both the authorize and callback legs
  TEST: "isShopifyOAuthConfigured is false with no env vars set"
  TEST: "isShopifyOAuthConfigured is false with only one of the two vars set"
  TEST: "exchangeCodeForToken reports not_configured rather than making a network call"
  TEST: "reports not_configured when SHOPIFY_CLIENT_ID/SECRET/REDIRECT_URI are unset"
  TEST: "503s before touching the database when unconfigured"

AC-2 — Only real *.myshopify.com domains are accepted — SSRF/open-redirect guard on the shop param
  TEST: "accepts a well-formed *.myshopify.com domain"
  TEST: "rejects a non-Shopify host (SSRF/open-redirect guard)"
  TEST: "rejects an empty or non-string shop value"
  TEST: "rejects a non *.myshopify.com shop domain"
  TEST: "rejects a non-myshopify.com shop before verifying anything else"

AC-3 — The authorize endpoint is owner-scoped and connector-type-checked before it will build a URL
  TEST: "a foreign connection reads as 404 even when configured"
  TEST: "rejects a connection whose connector_id is not shopify"

AC-4 — A real, correctly-shaped Shopify authorize URL is returned (client_id, redirect_uri, signed state)
  TEST: "returns a real Shopify authorize_url when configured, owned, and valid"

AC-5 — State is a self-contained, signed CSRF token: round-trips, rejects tampering, rejects expiry
  TEST: "a freshly signed state decodes back to the same manifest id"
  TEST: "a tampered state (different manifest id spliced in) is rejected"
  TEST: "an expired state is rejected"
  TEST: "garbage input does not throw"

AC-6 — The callback verifies the HMAC over the exact shopify.dev-documented algorithm before trusting anything
  TEST: "a correctly computed HMAC over the sorted, hmac-excluded query verifies"
  TEST: "a tampered query parameter fails verification"
  TEST: "a missing hmac param fails closed"
  TEST: "rejects a request with no hmac"
  TEST: "rejects a tampered query even with a well-formed hmac from a different payload"
  TEST: "rejects an expired or forged state even with a valid hmac"

AC-7 — Token exchange calls the documented endpoint with the documented body shape, and failures are reported not thrown
  TEST: "posts to https://{shop}/admin/oauth/access_token with client_id/client_secret/code"
  TEST: "rejects a non-Shopify shop domain before making any network call"
  TEST: "a non-2xx response is reported, not thrown"
  TEST: "a network failure is reported, not thrown"

AC-8 — A verified callback stores the credential, advances the connection state, and emits a vcaop.portal.* OASIS event; a failed exchange writes nothing and emits nothing
  TEST: "verified callback exchanges the code, stores the credential, and advances state" (also asserts the oasis_events insert)
  TEST: "a token-exchange failure is reported and never writes a credential"
  TEST: "a manifest that is not connector_id=shopify is rejected"

ROUTE_MOUNT: `POST /connections/:id/shopify/authorize` rides the existing `/api/v1/vcaop/portal/my` mount (unchanged, added VTID-03553). New public router `services/gateway/src/routes/shopify-oauth-callback.ts` mounted at `/api/v1/vcaop/shopify-oauth` in `services/gateway/src/index.ts`, distinct from the pre-existing `/api/v1/vcaop/shopify` (unrelated admin-only own-store catalog sync, `shopify-sync.ts` — confirmed non-duplicative before starting this VTID). See `docs/validation/VTID-03603/commands.log` step 6 for the confirming grep.
FINAL_URL: https://preview-gateway.vitanaland.com/api/v1/vcaop/portal/my/connections/{id}/shopify/authorize
FINAL_URL: https://preview-gateway.vitanaland.com/api/v1/vcaop/shopify-oauth/callback
CURL_PROOF: after merge-to-main auto-deploys staging: `curl -s -o /dev/null -w "%{http_code} %{content_type}" -X POST https://preview-gateway.vitanaland.com/api/v1/vcaop/portal/my/connections/x/shopify/authorize -H "Content-Type: application/json" -d '{}'` must return `401 application/json...` (auth required — route exists), NOT `404 text/html`. `curl -s -o /dev/null -w "%{http_code} %{content_type}" "https://preview-gateway.vitanaland.com/api/v1/vcaop/shopify-oauth/callback?code=x&shop=x.myshopify.com&state=x"` must return `503 application/json` (`not_configured`, since SHOPIFY_CLIENT_ID/SECRET are unset in staging) — NOT `404 text/html`.
OASIS_PROOF: a verified callback emits `vcaop.portal.connection.shopify_authorized` (source `vcaop-shopify-oauth`, `metadata.surface='merchant_self_service'`) through the same `oasis_events` insert pattern the admin/merchant portal routers already use — state transitions and decisions only, per CLAUDE.md §6. Verify post-merge: `SELECT type, message FROM oasis_events WHERE type = 'vcaop.portal.connection.shopify_authorized' ORDER BY created_at DESC LIMIT 5;` (will be empty until the connector is configured for real, since nothing can complete the OAuth round trip before then). The authorize leg emits nothing — it only returns a URL, no state change.
