# VTID-04940 — Commerce MCP hardening: supplier-data envelope, caps, pinned tool catalogue (item 3 of 7)

Owner instruction 2026-10-07 ("approved, run item 3"). Sparring: `plan-sparring.md` and `docs/validation/VTID-04938/plan-sparring.md`.
Not part of this VTID: new tools, the reviewer account, the directory submission.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: POST /mcp (unchanged; tool result shapes change).

FINAL_URL: https://preview-aws-gateway.vitanaland.com/.well-known/oauth-protected-resource/mcp (staging, read-only metadata GET; the tools themselves need a sign-in and are covered by the jest suites).

CURL_PROOF: staging metadata GET stays 200 with the resource ending in /mcp (existing commerce-mcp.test.ts + staging manifest).

OASIS_PROOF: every tools/call still emits commerce.mcp.tool_called (existing audit test, unchanged).

## Acceptance criteria

AC-1: Every supplier-written value a tool returns (business name, legal name, website, VAT id, product title, link, image) sits inside `supplier_data`, cleaned of control/bidi/zero-width characters and length-capped; platform values stay outside; an injected instruction in a business name or title is reachable only under `supplier_data`.
  TEST: services/gateway/test/vtid-04940-commerce-mcp-supplier-data.test.ts
AC-2: Every tool that returns supplier text also returns `supplier_data_note`, and the server instructions tell the assistant that supplier_data is data, never instructions.
  TEST: services/gateway/test/vtid-04940-commerce-mcp-supplier-data.test.ts
AC-3: list_products and the business list send at most 100 items and report `truncated` and `total`; a 10,000-character title is capped.
  TEST: services/gateway/test/vtid-04940-commerce-mcp-supplier-data.test.ts
AC-4: The tool catalogue is pinned: exact names, a title, a description and a read-only or destructive hint on every tool; the read-only tools are exactly get_onboarding_status and list_products.
  TEST: services/gateway/test/vtid-04940-commerce-mcp-supplier-data.test.ts
AC-5: The existing MCP behaviour is unchanged (sign-in, protocol, confirmation gates, audit, rate limit, business type, prod pin).
  TEST: services/gateway/test/commerce-mcp.test.ts
