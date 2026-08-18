# VTID-03605 — Acceptance (SMART on FHIR connector, Track 3 of the merchant-onboarding follow-up)

Scope of THIS PR: gateway-only (`services/gateway/src/**` + this evidence
pack — no new migration in this PR; reuses the already-applied, already-
generalized `partner_oauth_credential` table from VTID-03603's PR #3094,
column `endpoint_domain`). New `POST /connections/:id/fhir/authorize` on the
existing owner-scoped merchant router, a new public `GET /callback` router at
`/api/v1/vcaop/fhir-oauth`, and a new `services/gateway/src/services/
smart-fhir-oauth.ts`. EHR-agnostic (works against any server implementing
the SMART App Launch spec — Epic, Cerner/Oracle Health, Athenahealth, ...),
targeting the healthcare vertical of Discover (insurers, hospitals, doctors,
labs) per CLAUDE.md §13c. Dormant until `FHIR_OAUTH_STATE_SECRET` +
`FHIR_OAUTH_REDIRECT_URI` are set — no real EHR sandbox registration exists
in this session, so none of this can run for real yet. Unlike Shopify (one
global Partner-app credential), every connection supplies its own EHR-issued
`client_id`/`client_secret` in the authorize request body, never from env.

Also fixed in this PR (found while starting this VTID): the Shopify OAuth
callback (`shopify-oauth-callback.ts`) still wrote the DB column as
`shop_domain` after VTID-03603's follow-up migration renamed it to
`endpoint_domain` — a latent bug that would have made every real Shopify
credential write fail with a column-not-found error. Corrected alongside its
test assertion.

Verification tokens: TEST = jest suite (`services/gateway/test/services/
smart-fhir-oauth.test.ts`, `services/gateway/test/routes/
fhir-oauth-callback.test.ts`, `services/gateway/test/routes/
vcaop-portal-my.test.ts`, captured in ./outputs/fhir-oauth-tests.txt).

AC-1 — The connector is fully dormant without FHIR_OAUTH_STATE_SECRET, on both the authorize and callback legs
  TEST: "isFhirOAuthConfigured is false with no env var set"
  TEST: "signState throws not_configured rather than minting a token"
  TEST: "decodeAndVerifyState returns null rather than decrypting"
  TEST: "reports not_configured when FHIR_OAUTH_STATE_SECRET/REDIRECT_URI are unset"
  TEST: "503s before touching the database when unconfigured"

AC-2 — Only https FHIR base URLs are accepted, and discovery is SSRF-guarded (reused from platform-detect.ts, not duplicated)
  TEST: "accepts a well-formed https URL"
  TEST: "rejects http (SMART requires TLS)"
  TEST: "rejects an empty, non-string, or malformed value"
  TEST: "rejects a non-https base URL before any network call"
  TEST: "rejects a base URL that resolves to a private address"
  TEST: "rejects a non-https fhir_base_url before any discovery call"

AC-3 — Discovery fetches {fhirBaseUrl}/.well-known/smart-configuration and validates the response before trusting it
  TEST: "fetches {fhirBaseUrl}/.well-known/smart-configuration and parses endpoints"
  TEST: "strips a trailing slash on the base URL before appending the discovery path"
  TEST: "reports a malformed (non-JSON) discovery document rather than throwing"
  TEST: "reports a discovery document missing required endpoints"
  TEST: "a discovery failure surfaces as 502, not a crash"

AC-4 — PKCE (RFC 7636, S256) verifier/challenge are generated correctly
  TEST: "generateCodeVerifier produces an RFC7636-shaped value (43-128 chars, unreserved)"
  TEST: "generateCodeChallenge is the base64url(sha256(verifier)), per spec"

AC-5 — State is AES-256-GCM ENCRYPTED (not merely signed, unlike Shopify's state) so the code_verifier/client_secret it carries across the browser+EHR-AS round trip stay confidential, not just tamper-evident
  TEST: "a freshly signed state decrypts back to the same payload"
  TEST: "round-trips an optional client_secret without leaking it in plaintext"
  TEST: "the code_verifier is not recoverable from the state without the key"
  TEST: "a tampered ciphertext byte is rejected (GCM auth tag fails)"
  TEST: "a state encrypted under a different secret is rejected"
  TEST: "an expired state is rejected"
  TEST: "garbage input does not throw"
  TEST: "rejects garbage state"
  TEST: "rejects a state encrypted with a stale secret (rotated key)"

AC-6 — The authorize endpoint is owner-scoped and connector-type-checked before it will run discovery or build a URL
  TEST: "a foreign connection reads as 404 even when configured"
  TEST: "rejects a connection whose connector_id is not smart_fhir"
  TEST: "requires a client_id"

AC-7 — A real, standalone-launch SMART authorize URL is returned with every required param (response_type, client_id, redirect_uri, scope, state, aud, code_challenge, code_challenge_method=S256, no launch param)
  TEST: "builds a standalone-launch authorize URL with every required SMART param"
  TEST: "returns null for a malformed authorization endpoint"
  TEST: "returns null for a non-https authorization endpoint"
  TEST: "returns a real SMART authorize_url when configured, owned, and valid"
  TEST: "honors a caller-supplied scope instead of the default"

AC-8 — Token exchange posts the documented SMART body shape (grant_type, code, redirect_uri, code_verifier, client_id, optional client_secret) and failures are reported not thrown
  TEST: "posts the documented SMART token-exchange body"
  TEST: "includes client_secret when supplied (confidential client)"
  TEST: "rejects a non-https token endpoint before making any network call"
  TEST: "a non-2xx response is reported, not thrown"
  TEST: "a missing access_token in a 200 response is reported"
  TEST: "a network failure is reported, not thrown"

AC-9 — A verified callback stores the credential, advances the connection state, and emits a vcaop.portal.* OASIS event; a failed exchange writes nothing and emits nothing
  TEST: "verified callback exchanges the code, stores the credential, and advances state" (also asserts the oasis_events insert and that the token POST uses the pinned endpoint/verifier/client from state)
  TEST: "a token-exchange failure is reported and never writes a credential"
  TEST: "a manifest that is not connector_id=smart_fhir is rejected"
  TEST: "a manifest that does not exist is rejected"
  TEST: "surfaces an authorization_denied error from the EHR without touching state"
  TEST: "rejects a request with no code or state"

AC-10 — The Shopify shop_domain/endpoint_domain column-rename regression is fixed and covered
  TEST: "verified callback exchanges the code, stores the credential, and advances state" (shopify-oauth-callback.test.ts, asserts `endpoint_domain` in the upsert payload)

ROUTE_MOUNT: `POST /connections/:id/fhir/authorize` rides the existing `/api/v1/vcaop/portal/my` mount (unchanged, added VTID-03553). New public router `services/gateway/src/routes/fhir-oauth-callback.ts` mounted at `/api/v1/vcaop/fhir-oauth` in `services/gateway/src/index.ts`, mirroring the Shopify callback's mount shape but under its own path. See ./commands.log step 5 for the confirming grep.
FINAL_URL: https://preview-gateway.vitanaland.com/api/v1/vcaop/portal/my/connections/{id}/fhir/authorize
FINAL_URL: https://preview-gateway.vitanaland.com/api/v1/vcaop/fhir-oauth/callback
CURL_PROOF: after merge-to-main auto-deploys staging: `curl -s -o /dev/null -w "%{http_code} %{content_type}" -X POST https://preview-gateway.vitanaland.com/api/v1/vcaop/portal/my/connections/x/fhir/authorize -H "Content-Type: application/json" -d '{}'` must return `401 application/json...` (auth required — route exists), NOT `404 text/html`. `curl -s -o /dev/null -w "%{http_code} %{content_type}" "https://preview-gateway.vitanaland.com/api/v1/vcaop/fhir-oauth/callback?code=x&state=x"` must return `503 application/json` (`not_configured`, since FHIR_OAUTH_STATE_SECRET is unset in staging) — NOT `404 text/html`.
OASIS_PROOF: a verified callback emits `vcaop.portal.connection.fhir_authorized` (source `vcaop-fhir-oauth`, `metadata.surface='merchant_self_service'`) through the same `oasis_events` insert pattern the Shopify connector and the rest of the merchant portal already use — state transitions and decisions only, per CLAUDE.md §6. Verify post-merge: `SELECT type, message FROM oasis_events WHERE type = 'vcaop.portal.connection.fhir_authorized' ORDER BY created_at DESC LIMIT 5;` (will be empty until the connector is configured for real and a merchant completes a live EHR round trip, since nothing can complete the OAuth exchange before then). The authorize leg emits nothing — it only runs discovery and returns a URL, no state change (impact-scan-marked `// impact-allow-no-oasis`).
