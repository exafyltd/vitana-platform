# VTID-03601 — Acceptance (Storefront platform detection, Track 4 of the merchant-onboarding follow-up)

Scope of THIS PR: gateway-only (`services/gateway/src/**` + this evidence pack).
New `POST /api/v1/vcaop/portal/my/connections/detect-platform` on the existing
owner-scoped merchant router (mounted since VTID-03553, unchanged mount point).
Companion vitana-v1 PR (#986) wires this into the connect dialog.

Verification tokens: TEST = jest suite (`services/gateway/test/services/
platform-detect.test.ts` + `services/gateway/test/routes/vcaop-portal-my.test.ts`,
captured in ./outputs/platform-detect-tests.txt).

AC-1 — Non-http(s) URLs and unparseable input are rejected before any network call
  TEST: "rejects an invalid URL"
  TEST: "rejects non-http(s) protocols"
  TEST: "rejects file:// URLs"

AC-2 — Raw private/internal IPv4 literals are rejected without a DNS lookup, incl. cloud metadata
  TEST: "rejects a raw private IPv4 literal without needing a DNS lookup" (169.254.169.254)
  TEST: "rejects loopback"
  TEST: "rejects RFC1918 10.x literal"

AC-3 — A hostname that RESOLVES to a private address is rejected before the request is made
  TEST: "rejects a hostname that resolves to a private address"
  TEST: "rejects a hostname with a MIXED public+private resolution (any private hit blocks)"

AC-4 — Every redirect hop is re-validated against the same private-address guard (no bypass via redirect)
  TEST: "rejects a redirect that points at a private address (re-validates every hop)"
  TEST: "follows a legitimate same-scheme redirect and detects on the final page"
  TEST: "gives up after too many redirects"
  TEST: "rejects a redirect response with no Location header"

AC-5 — Known platforms are fingerprinted with high confidence from headers/body markers
  TEST: "detects Shopify via the x-shopid header"
  TEST: "detects Shopify via a body content signal"
  TEST: "detects WooCommerce via a Woo-specific body signal"
  TEST: "detects Magento"
  TEST: "detects BigCommerce"

AC-6 — Plain WordPress (no commerce plugin) is surfaced as a low-confidence hint, never mislabeled as WooCommerce
  TEST: "plain WordPress (no Woo signal) does NOT get tagged as woocommerce"

AC-7 — No match is a normal outcome (ok:true, confidence:none), not an error
  TEST: "returns confidence \"none\" when nothing matches"

AC-8 — A network failure is reported in the response, not thrown/500'd
  TEST: "a fetch failure is reported, not thrown"

AC-9 — The route validates input before calling the detector, and is read-only w.r.t. Supabase
  TEST: "requires a url"
  TEST: "is read-only — never touches the database"

AC-10 — A blocked/failed detection surfaces as 422 (client-actionable), not 500
  TEST: "an SSRF-blocked or failed detection surfaces as 422, not 500"

ROUTE_MOUNT: No new mount — `POST /connections/detect-platform` is added to the router already exported by `services/gateway/src/routes/vcaop-portal-my.ts`, which has been mounted at `/api/v1/vcaop/portal/my` via `mountRouterSync` in `services/gateway/src/index.ts` since VTID-03553 (unchanged by this PR; see `docs/validation/VTID-03601/commands.log` step 4 for the confirming grep).
FINAL_URL: https://preview-gateway.vitanaland.com/api/v1/vcaop/portal/my/connections/detect-platform
CURL_PROOF: after merge-to-main auto-deploys staging, `curl -s -o /dev/null -w "%{http_code} %{content_type}" -X POST https://preview-gateway.vitanaland.com/api/v1/vcaop/portal/my/connections/detect-platform -H "Content-Type: application/json" -d '{}'` must return `401 application/json...` (auth required — route exists) — NOT `404 text/html` (route missing, per CLAUDE.md §15's HTML-vs-JSON diagnostic).
OASIS_PROOF: not applicable — this handler is read-only (never writes to `partner_tenant`/`integration_manifest`/any table) and is explicitly marked `// impact-allow-no-oasis` per the impact-scan bot's own escape hatch for mutations with no state transition to record. See OASIS_IMPACT below.
