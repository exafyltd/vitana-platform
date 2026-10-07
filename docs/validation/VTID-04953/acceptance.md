# VTID-04953 — Commerce checklist policy v1 (owner decisions B3/B4)

Owner decisions 2026-10-07. B3: for manual or MCP catalogues, mapping is complete when there is at least one complete
offering; external-feed mapping applies only when an external catalogue connector exists. B4: for service_provider v1,
tracking_test and billing_mandate are not required until those systems exist. No migration; no lifecycle move happens
by itself; nothing is deployed to production by this change.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: none added. Existing /api/v1/partner-onboarding/:orgId (checklist) now reads the org's catalogue source.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/partner-onboarding/00000000-0000-0000-0000-000000000000 (staging, read-only)

CURL_PROOF: after the merge's staging deploy, an unsigned GET of the checklist route returns 401 JSON (STAGING-VERIFY, docs/validation/VTID-04953/staging-tests.json); the rule changes are proven by the Jest suites below.

OASIS_PROOF: n/a (no new topics; derived mapping writes no row and emits no event, like account/company/terms).

## Acceptance criteria

AC-1: Service providers no longer require tracking_test or billing_mandate (they show not_required); supplier_shop, affiliate_brand, lab and practitioner_clinic keep their required steps.
  TEST: services/gateway/test/vtid-04953-checklist-policy.test.ts
AC-2: With no external catalogue connection, mapping is done once the org has one complete offering and todo (missing complete_offering) otherwise; a stale stored mapping row is ignored; an offering kept offline still counts.
  TEST: services/gateway/test/vtid-04953-checklist-policy.test.ts
AC-3: With a connection, the stored row written by the connections reconcile stays the source of truth for mapping.
  TEST: services/gateway/test/vtid-04953-checklist-policy.test.ts
AC-4: A complete offering has every field ProductSchema requires (title, price, currency, link, origin country, somewhere it is offered); an offering missing any of them does not count.
  TEST: services/gateway/test/vtid-04953-checklist-policy.test.ts
AC-5: The checklist loader reads the connection count and the org's offerings and fails the load on a read error; existing checklist routes keep working.
  TEST: services/gateway/test/partner-onboarding.test.ts
AC-6: An admin approval of a service provider with a catalogue and one complete offering takes it live through the lifecycle graph; a kept-offline offering stays off.
  TEST: services/gateway/test/vtid-04933-partner-review.test.ts
AC-7: The assistant tells a supplier without a connection to add a complete offering (add_product), never connect_store; with a connection it still suggests connect_store; not_required steps are not marked done on Vitanaland.
  TEST: services/gateway/test/commerce-mcp.test.ts
AC-8: On staging after merge, the checklist route is mounted behind auth.
  CURL: GET https://preview-aws-gateway.vitanaland.com/api/v1/partner-onboarding/00000000-0000-0000-0000-000000000000
