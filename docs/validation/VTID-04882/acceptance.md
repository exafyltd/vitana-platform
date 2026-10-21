# VTID-04882 — Commerce MCP advertises email/profile scopes

Follow-up to VTID-04847. On 2026-10-05 a real Claude connection to the staging
Commerce MCP endpoint reached Supabase's token exchange and failed there:
Claude requested `scope=openid profile email phone offline_access`, and
`POST /auth/v1/oauth/token` answered 500 with "HS256 is not supported for ID
token signing" (Supabase auth logs, read-only). Our protected-resource metadata
named no scopes, so Claude took Supabase's full list. Owner decision 2026-10-05:
try advertising scopes first; the signing-key migration stays the fallback.

VALIDATION_PROFILE: gateway_backend

CURL_PROOF: after the staging deploy STAGING-VERIFY runs docs/validation/VTID-04882/staging-tests.json — `curl -s https://preview-aws-gateway.vitanaland.com/.well-known/oauth-protected-resource/mcp` contains `"scopes_supported":["email","profile"]`; an unsigned `POST /mcp` answers 401 (rejected probe; nothing is written).

## Acceptance criteria

AC-1: The protected-resource metadata advertises exactly `scopes_supported: ["email", "profile"]` and never `openid`.
  TEST: services/gateway/test/commerce-mcp.test.ts
AC-2: The 401 challenge carries `scope="email profile"` alongside `resource_metadata`, and no `openid`.
  TEST: services/gateway/test/commerce-mcp.test.ts
AC-3: Nothing else changes: token verification (`verifyAndExtractIdentity`), tools, routes and the COMMERCE_MCP_ENABLED switch (staging only) are untouched.
  TEST: services/gateway/test/commerce-mcp.test.ts

## Stop rule (from the sparred plan)

The owner re-runs the real Claude connection once; the Supabase auth logs are read
(read-only). If Claude still requests `openid`, stop and return to the owner with the
signing-key path as a separate VTID — no further scope-hint iterations.

## Scope

- Changed: `services/gateway/src/routes/commerce-mcp.ts` (MCP_SCOPES, metadata, challenge), `services/gateway/test/commerce-mcp.test.ts`, this pack.
