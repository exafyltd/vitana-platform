# VTID-04847 — Commerce MCP endpoint for supplier onboarding

Owner request and decisions 2026-10-02: "copy MCP address → connect AI → tell
AI what business to onboard → AI performs the setup → user approves
sensitive actions". Hosted by the gateway at /mcp; sign-in through Supabase
Auth's OAuth 2.1 server; submit for verification and post-verification company
changes need the supplier's confirmation; terms are accepted on screen only.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: services/gateway/src/index.ts — `mountRouterSync(app, '/mcp', commerceMcpModule.default, { owner: 'commerce-mcp' })` and `mountRouterSync(app, '/.well-known', commerceMcpModule.wellKnownRouter, { owner: 'commerce-mcp-well-known' })`
FINAL_URL: POST /mcp (MCP Streamable HTTP, stateless JSON) · GET /.well-known/oauth-protected-resource[/mcp] (RFC 9728); 404 COMMERCE_MCP_DISABLED unless COMMERCE_MCP_ENABLED=true (set on staging only)
CURL_PROOF: after the staging deploy STAGING-VERIFY runs docs/validation/VTID-04847/staging-tests.json — `curl -s https://preview-aws-gateway.vitanaland.com/.well-known/oauth-protected-resource/mcp` answers JSON naming `<SUPABASE_URL>/auth/v1`, and an unsigned `POST /mcp` answers 401 with `WWW-Authenticate: Bearer resource_metadata=…` (rejected probe; nothing is written). Not run from the authoring session: the routes are not deployed until this merges.

OASIS_PROOF: every tools/call emits `commerce.mcp.tool_called` (vtid VTID-04847, source commerce-mcp, actor = the user, actor_role agent, payload: tool, organization_id, client_id, outcome, error_code, field names only) — asserted in services/gateway/test/commerce-mcp.test.ts ("every tool call is audited with field names, never values"); each write also emits its own partner_org.* event through the shared services.

## Acceptance criteria

AC-1: Off by default; with the switch on, the protected-resource metadata names this endpoint and Supabase Auth as authorization server; a request without a valid Vitanaland token is answered 401 with the metadata link.
  TEST: services/gateway/test/commerce-mcp.test.ts
AC-2: MCP over Streamable HTTP: initialize (version negotiation, tools capability, instructions), notifications (202), ping, tools/list, tools/call, batches; unknown methods and tools are JSON-RPC errors; GET/DELETE 405.
  TEST: services/gateway/test/commerce-mcp.test.ts
AC-3: Tools get_onboarding_status, create_business, update_business, add_product, list_products, update_product, submit_for_verification act as the signed-in user through the Commerce services (never as exafy_admin); there is no terms tool.
  TEST: services/gateway/test/commerce-mcp.test.ts
AC-4: Sensitive actions need the supplier's confirmation: submit_for_verification and a company change that voids a passed verification answer confirmation_required without confirmed=true and change nothing.
  TEST: services/gateway/test/commerce-mcp.test.ts
  TEST: services/gateway/test/vtid-04847-partner-onboarding-service.test.ts
AC-5: Permission checks are inside the services: a non-org_admin is refused before anything is read; the routes skip the repeat lookup only after their own middleware; service refusals reach the assistant as structured errors (forbidden, not_found, conflict, prerequisites_missing, invalid_input, confirmation_required, rate_limited, unavailable, internal).
  TEST: services/gateway/test/vtid-04847-partner-onboarding-service.test.ts
  TEST: services/gateway/test/commerce-mcp.test.ts
AC-6: Start, company, submit, catalogue list and product update moved into services/partner-onboarding-service.ts; the routes answer exactly as before.
  TEST: services/gateway/test/partner-onboarding.test.ts
  TEST: services/gateway/test/partner-onboarding-catalogue.test.ts
AC-7: Audit: one commerce.mcp.tool_called per call with field names, never values; a per-user budget of 120 calls a minute.
  TEST: services/gateway/test/commerce-mcp.test.ts

## Scope

- New: `services/commerce-mcp.ts`, `routes/commerce-mcp.ts`, `services/partner-onboarding-service.ts`, two Jest suites, this pack.
- Changed: routes partner-onboarding.ts and partner-onboarding-catalogue.ts delegate to the service; index.ts mounts; domain atlas claims the route; `commerce.mcp.tool_called` event type; staging workflow sets COMMERCE_MCP_ENABLED (prod unchanged) and the generated flag pins follow.
- No migration. Needs (owner): Supabase Auth → OAuth Server enabled with dynamic client registration and an authorization path on the Vitanaland app (VTID-04848 builds the consent screen).
