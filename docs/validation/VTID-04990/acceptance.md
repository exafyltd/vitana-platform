# VTID-04990 — a ChatGPT-only Commerce MCP path so ChatGPT can finish sign-in

Owner decision 2026-10-08 ("approve B and loopback, go ahead"). Sparring: `plan-sparring.md` (standard class, 2 rounds, CONVERGED). Evidence for the problem: ChatGPT's desktop client (client name "Codex") requests scope `openid profile email phone offline_access`; Supabase's `/oauth/token` then fails with 500 "HS256 is not supported for ID token signing" (2026-10-08 15:15 UTC), so ChatGPT never gets a token. Next gate behind it: the approved-client rule refuses a loopback redirect `http://127.0.0.1:<port>`.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: services/gateway/src/index.ts mounts the existing commerce-mcp router at /mcp; this change adds `POST /mcp/chatgpt` to that same router and three GET routes to the existing `wellKnownRouter` at /.well-known. No new mount.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/.well-known/oauth-authorization-server (staging, read-only GET).

OASIS_PROOF: the loopback approval emits `commerce.mcp.loopback_client_approved` (client_id, client_name, path), once per client per hour, and a refused client emits `commerce.mcp.client_refused` with the path; both are asserted in services/gateway/test/vtid-04990-chatgpt-oauth.test.ts ("a loopback client is audited once per hour, with its (self-declared) name", "a refused client is 403 CLIENT_NOT_APPROVED with the path in the audit event").

CURL_PROOF: staging returns 200 with `"scopes_supported":["email","profile"]` for the authorization-server document and for the Claude resource metadata, 200 for `/.well-known/oauth-protected-resource/mcp/chatgpt`, and an unsigned POST to `/mcp/chatgpt` and `/mcp` each returns 401.

## Acceptance criteria

AC-1: With `COMMERCE_MCP_CHATGPT` unset (production's state) `/mcp/chatgpt`, `/.well-known/oauth-protected-resource/mcp/chatgpt` and `/.well-known/oauth-authorization-server` answer 404, and a `COMMERCE_MCP_CHATGPT` value other than exactly `true`, or `COMMERCE_MCP_ENABLED` unset, keeps them off.
  TEST: services/gateway/test/vtid-04990-chatgpt-oauth.test.ts
AC-2: `/mcp` is unchanged, with the switch off and on: the protected-resource metadata is byte-for-byte today's (Supabase as authorization server) and the 401 challenge is the same string; the client check on `/mcp` is called without loopback.
  TEST: services/gateway/test/vtid-04990-chatgpt-oauth.test.ts
AC-3: The authorization-server document (switch on) has issuer = the gateway origin, Supabase's authorization/token/registration endpoints, scopes `email profile`, and no openid/jwks/userinfo/ID-token fields; without a Supabase URL it is 503.
  TEST: services/gateway/test/vtid-04990-chatgpt-oauth.test.ts
AC-4: `/mcp/chatgpt` serves the same tools through the same auth and rate limit; its 401 challenge points `resource_metadata` at the ChatGPT resource metadata; GET is 405 POST-only.
  TEST: services/gateway/test/vtid-04990-chatgpt-oauth.test.ts
AC-5: A loopback redirect (`http://127.0.0.1|[::1]|localhost`, any port/path) is approved only on `/mcp/chatgpt`; look-alikes, other loopback addresses, https loopback, mixed sets with a stranger, and any other path are refused; approved hosts behave as before. A loopback client is audited once per hour with its self-declared name.
  TEST: services/gateway/test/vtid-04990-chatgpt-oauth.test.ts
AC-6: A delegated token reaches `/mcp/chatgpt` and the new well-known documents and nothing else.
  TEST: services/gateway/test/vtid-04990-chatgpt-oauth.test.ts
AC-7: The plugin package's MCP URL is the ChatGPT path in both layouts; the package test pins it.
  TEST: services/gateway/test/vtid-04980-chatgpt-plugin-package.test.ts
AC-8: Staging pins `COMMERCE_MCP_CHATGPT=true`; production keeps it off until the owner approves activation (generic `env_overrides`, rollback by setting it `false`).
  TEST: services/gateway/test/vtid-04990-chatgpt-oauth.test.ts

## Security statement (owner-acknowledged)
Loopback approval is an intentional relaxation limited to `/mcp/chatgpt`: any desktop app on the user's own machine that the user signs in and consents for is accepted, not only named assistants. Never on `/mcp`; delegated tokens stay confined to `/mcp*` and `/.well-known/*`; every client is audited; the switch kills the path. `client_name` is self-declared and never trusted. The redirect-host line on the consent screen is in the held frontend commit and is not in production yet.

## Limits
- The issuer in the authorization-server shim is the gateway while tokens carry Supabase's `iss`; that ChatGPT accepts this is an assumption, bounded to the ChatGPT path.
- ChatGPT can only be pointed at production, so the real end-to-end proof happens after the owner approves activation; rollback is one env-only dispatch.
- Jest cannot run in the session (registry blocked); CI is the first run.
