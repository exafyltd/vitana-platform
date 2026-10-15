# VTID-05209 — Commerce profile: suggested country and website (gateway)

Owner approval 2026-10-15 (Gate 1 yes). Sparring: `plan-sparring.md` (CONVERGED, 2 rounds, standard class).
One VTID across `exafyltd/vitana-platform` (this PR, merges first) and `exafyltd/vitana-v1` (screens, second).
No migration. No change to registration/company validation, verification, terms or the checklist.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: services/gateway/src/routes/partner-onboarding.ts → router.get('/company-suggestions', requireAuth, …) registered before router.get('/:orgId', …), and router.get('/:orgId/company-suggestions', requireAuth, requireOrgAdmin(), …); the router is already mounted in src/index.ts via mountRouterSync(app, '/api/v1/partner-onboarding', partnerOnboardingRouter, …) — no new mount, no new route file
FINAL_URL: GET {gateway}/api/v1/partner-onboarding/company-suggestions and GET {gateway}/api/v1/partner-onboarding/:orgId/company-suggestions
CURL_PROOF: staging only, read-only, by STAGING-VERIFY (`staging-tests.json` tests 1–2): both URLs on https://preview-aws-gateway.vitanaland.com → 401 `application/json` without a login; the signed-in 200 shape is read by the frontend staging spec (vitana-v1 VTID-05209). Never run against production. Local proof: Jest AC-2/AC-3.
OASIS_PROOF: none — read-only routes, no new OASIS event.

## Acceptance criteria

AC-1: `inferCompanyFacts` — saved values always win; country from the EU VAT prefix (`EL`→GR), the website's country-code domain (multi-part suffixes such as `.co.uk` read first; generic/vanity endings give nothing) or, with no website known, the confirmed business email's domain; website from a confirmed, non-free-mail email domain; two reliable sources that disagree give no country. No IP lookup and no network I/O.
  TEST: services/gateway/test/vtid-05209-company-suggestions.test.ts (countryFromHost, countryFromVatId, inferCompanyFacts)
AC-2: `GET /api/v1/partner-onboarding/company-suggestions` (auth) is registered before `GET /:orgId`, is reachable, reads only the caller's email confirmation, writes nothing, and returns `{ ok, country, website }` only.
  TEST: services/gateway/test/vtid-05209-company-suggestions.test.ts ("is reachable — not captured by GET /:orgId")
AC-3: `GET /api/v1/partner-onboarding/:orgId/company-suggestions` — org admin only (403 otherwise); saved values win and the email is not read when both are saved; read-only.
  TEST: services/gateway/test/vtid-05209-company-suggestions.test.ts ("business profile")
AC-4: Commerce MCP status — while country or website is missing, `suggested` carries value + plain-words source and the company `next_action.how` says to confirm with the supplier before `update_business`; a saved value is never re-suggested; without suggestions the status is unchanged.
  TEST: services/gateway/test/vtid-05209-company-suggestions.test.ts ("Commerce MCP status") + existing commerce-mcp suites
AC-5: Both routes are mounted on staging and refuse an unauthenticated caller.
  CURL: GET /api/v1/partner-onboarding/company-suggestions → 401; GET /api/v1/partner-onboarding/<uuid>/company-suggestions → 401 (staging-tests.json)
