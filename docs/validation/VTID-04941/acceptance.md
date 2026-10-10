# VTID-04941 — Commerce MCP automation, phase A: check_verification, connect_store, next_action, website guard

Owner instruction 2026-10-07 ("run phase a"). Sparring: `plan-sparring.md` (converged, 3 rounds).
Not part of this VTID: phase B (tracking test), phase C (decision brief), unpublish_product, the reviewer account, the directory submission.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: POST /mcp (unchanged mount; two new tools); the portal routes POST /api/v1/partner-onboarding/:orgId/{verification/check,detect,connections} keep their contracts and now call shared services.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/.well-known/oauth-protected-resource/mcp (staging, read-only metadata GET; the tools need a sign-in and are covered by the jest suites).

CURL_PROOF: staging metadata GET stays 200 with the resource ending in /mcp (existing commerce-mcp.test.ts + staging manifest).

OASIS_PROOF: every tools/call still emits commerce.mcp.tool_called; the moved checks still emit partner_org.verification_checked, partner_org.platform_detected and partner_org.connection_started (partner-onboarding suites).

## Acceptance criteria

AC-1: `check_verification` runs the same checks as the portal route as the signed-in org admin, returns the DNS TXT or meta-tag proof when ownership is unproven, and within a 10 s budget returns a partial result (`partial`, `retry_after_seconds`, the slow check `unavailable`, no level credited) instead of blocking.
  TEST: services/gateway/test/vtid-04941-verification-service.test.ts
AC-2: `check_verification` and `connect_store` are exposed as write, non-destructive, idempotent tools; connect_store starts or reuses a connection, returns the Vitanaland portal link and never a raw OAuth URL or secrets, keeps site-derived text inside supplier_data, and turns a missing website or an unreachable site into structured errors.
  TEST: services/gateway/test/vtid-04941-commerce-mcp-automation.test.ts
AC-3: `get_onboarding_status` keeps `next_step` and adds a structured `next_action` (tool the assistant can call, or what only the supplier can do plus the portal link); verification and mapping are no longer on-screen-only.
  TEST: services/gateway/test/vtid-04941-commerce-mcp-automation.test.ts
AC-4: A website pointing at a loopback, private, link-local or IPv6/IPv4-mapped internal address is refused when stored (`update_business`) and never fetched by check_verification; the shared guard handles bracketed IPv6 and hex-mapped IPv4.
  TEST: services/gateway/test/vtid-04941-verification-service.test.ts
AC-5: The portal routes behave as before after the extraction (verification, detect, connections, onboarding) and the existing MCP behaviour is unchanged.
  TEST: services/gateway/test/partner-onboarding-verification.test.ts
  TEST: services/gateway/test/partner-onboarding-connections.test.ts
  TEST: services/gateway/test/partner-onboarding.test.ts
  TEST: services/gateway/test/commerce-mcp.test.ts
