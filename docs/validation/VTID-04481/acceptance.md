# VTID-04481 — Commerce partner onboarding Phase 1: `POST /partner-onboarding/:orgId/detect`

Spec §6.2 of `docs/COMMERCE-SELF-SERVICE-PARTNER-ONBOARDING-SPEC.md`: website → platform detection, with a company pre-fill.

## What changed

- **`POST /api/v1/partner-onboarding/:orgId/detect`** (org_admin only):
  - takes `website` from the body, or falls back to the org's stored website;
  - validates it with the same rule as the company step (http or https only);
  - runs the existing SSRF-guarded `detectPlatform`;
  - stores the result on the org as `business_details.platform_detection`, merged into the existing JSON;
  - emits `partner_org.platform_detected`;
  - returns `detection` plus `suggested: {website, display_name}`.
- **The pre-fill is a suggestion only.** No company fact and no display name is written. The partner confirms through `PATCH /company`.
- **`services/platform-detect.ts`:** the result gains an additive field, `site_name`, taken from `og:site_name` (either attribute order) or else `<title>`. Entities are decoded, whitespace collapsed and the length capped at 120. Existing callers are unaffected.

## Acceptance criteria

AC-1 Without a website in the body or on the org: 400 `WEBSITE_REQUIRED`. A non-http(s) website: 400. In both cases the detector is never called. The route is org_admin only.
TEST: services/gateway/test/partner-onboarding.test.ts

AC-2 On success:
- the detection is stored on the org, and the existing `business_details` keys are kept;
- `suggested.display_name` comes from the site name;
- no company fact (`legal_name`, `country`, `vat_id`, `website`, `display_name`) is written;
- `partner_org.platform_detected` carries the connector and confidence.
TEST: services/gateway/test/partner-onboarding.test.ts

AC-3 When the detector refuses the URL (e.g. `blocked_private_address`), the route returns 422 `DETECTION_FAILED` with the reason, writes nothing and emits no event.
TEST: services/gateway/test/partner-onboarding.test.ts

AC-4 `extractSiteName`:
- prefers `og:site_name` in either attribute order and decodes entities;
- falls back to `<title>` and collapses whitespace;
- returns null when there is no name;
- caps the name at 120 characters.
TEST: services/gateway/test/services/platform-detect.test.ts

## Route mount

ROUTE_MOUNT: the existing `mountRouterSync(app, '/api/v1/partner-onboarding', …)` (VTID-04478); this adds `router.post('/:orgId/detect', …)` to that router.
FINAL_URL: `https://preview-aws-gateway.vitanaland.com/api/v1/partner-onboarding/<orgId>/detect` (staging, after merge).
CURL_PROOF: **not yet run.** The handler is new and deployed nowhere, so a response written down now would be invented.
- **Before merge:** `test/partner-onboarding.test.ts` exercises the real router with supertest.
- **After the staging deploy:** `curl -s -o /dev/null -w "%{http_code} %{content_type}" -X POST https://preview-aws-gateway.vitanaland.com/api/v1/partner-onboarding/00000000-0000-0000-0000-000000000000/detect` should return `401 application/json`.
CURL: see CURL_PROOF above.

## OASIS

OASIS_IMPACT: yes. New topic `partner_org.platform_detected`, with payload `partner_organization_id`, `connector_id`, `provider_id` and `confidence`. The URL is not in the payload; it stays on the org row.

OASIS_PROOF: the route suite asserts the event on success and that there is none on a refused URL. Once deployed, check with:
`SELECT topic, metadata->>'connector_id', metadata->>'confidence' FROM oasis_events WHERE topic = 'partner_org.platform_detected' ORDER BY created_at DESC LIMIT 5;`

## Not in this VTID

- No schema change: `business_details` is existing JSONB.
- The connections step using the stored detection comes in a later VTID.
- The DNS-rebinding caveat recorded in `platform-detect.ts`'s own header is unchanged.
