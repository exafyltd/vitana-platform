# VTID-05133 — "Connect your AI": the Maxina Community MCP for ChatGPT and Claude

Owner approval 2026-10-13 (Gate 1, "Yes"). Sparring: `plan-sparring.md` (standard class, rounds 1–2 CONVERGED before approval; mid-flight amendments A1 and A2 each one round, CONVERGED). This PR is the gateway half; the consent screen, Settings → Connected AI and the member opt-in (`profile_privacy_settings.ai_discoverable`) are the `exafyltd/vitana-v1` half of the same VTID.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: services/gateway/src/index.ts mounts the new `routes/community-mcp.ts` router at `/mcp/community` (POST `/` and `/chatgpt`) and its `communityWellKnownRouter` at `/.well-known` (two GET metadata routes), both BEFORE the existing Commerce mounts at `/mcp` and `/.well-known`.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/.well-known/oauth-protected-resource/mcp/community (staging, read-only GET).

OASIS_PROOF: every tool call emits `community.mcp.tool_called` (tool, client_id, path, outcome, error_code, result_count — never arguments or member data); a refused client or missing/revoked grant emits `community.mcp.client_refused` with the reason; a loopback client on the ChatGPT path emits `community.mcp.loopback_client_approved` once per hour; a Community-only or disconnected grant refused on Commerce emits `commerce.mcp.client_refused` with reason `not_granted_commerce`. Asserted in services/gateway/test/vtid-05133-community-mcp-tools.test.ts ("one event per call, with no arguments or member data") and services/gateway/test/community-mcp.test.ts ("a client outside the allowlist → 403 CLIENT_NOT_APPROVED", "loopback is allowed on the ChatGPT path only (and audited once)", "a Community-only grant is refused on /mcp").

CURL_PROOF: staging returns 200 with `"resource_name":"Maxina Community"` for `/.well-known/oauth-protected-resource/mcp/community`, 200 for the `/chatgpt` variant, 200 with `"scopes_supported":["email","profile"]` for `/.well-known/oauth-authorization-server`, and an unsigned POST to `/mcp/community`, `/mcp/community/chatgpt` and `/mcp` each returns 401.

## Acceptance criteria

AC-1: `/mcp/community`, `/mcp/community/chatgpt` and their metadata answer 404 unless `COMMUNITY_MCP_ENABLED` is exactly `true`; the ChatGPT path also needs `COMMUNITY_MCP_CHATGPT=true`; GET is 405 POST-only.
  TEST: services/gateway/test/community-mcp.test.ts
AC-2: An unsigned call gets 401 with `WWW-Authenticate` pointing `resource_metadata` at the path's own metadata; the Claude path's metadata names Supabase Auth, the ChatGPT path's names this gateway; scopes are `email profile` only. The shared authorization-server shim is served when either the Commerce or the Community ChatGPT path is on, and 404 when neither.
  TEST: services/gateway/test/community-mcp.test.ts
AC-3: Only approved assistants (the Commerce client allowlist) may call; the member's own session (no OAuth client) is refused; loopback redirects are approved on the ChatGPT path only and audited once per hour.
  TEST: services/gateway/test/community-mcp.test.ts
AC-4: Every call needs the member's grant for this assistant (`ai_connection_grants`): no row → 403 PERMISSION_NEEDED, revoked → 403 CONNECTION_REVOKED, lookup error → 503 (fail closed); a tool outside the granted categories answers `permission_needed` and reads nothing.
  TEST: services/gateway/test/community-mcp.test.ts, services/gateway/test/vtid-05133-community-mcp-tools.test.ts
AC-5: Commerce stays separate: a client whose grant lacks `commerce`, or is disconnected, is refused on `/mcp`; a client with no grant row (every pre-existing Commerce connection) works exactly as before; every existing Commerce MCP suite passes unchanged.
  TEST: services/gateway/test/community-mcp.test.ts, services/gateway/test/commerce-mcp.test.ts, services/gateway/test/vtid-04990-chatgpt-oauth.test.ts
AC-6: Another member leaves Vitana only as the public card (vitana_id, display name, avatar unless private, city only when public, ≤ 5 public interests, Maxina link) and only if they opted in (`ai_discoverable` AND `searchable`), are visible in the community, in the caller's tenant and not a test/service account; the check fails closed; matches who did not opt in are counted only.
  TEST: services/gateway/test/vtid-05133-community-mcp-tools.test.ts
AC-7: Health-derived data never leaves: match reasons `similar_index`/`shared_pillar` and legacy free-text reasons are dropped; `find_people` never uses the Vitana-Index-capable ranker and writes no search history; profile goals in a health category are dropped; no health, contact or birth-date field appears in any tool output.
  TEST: services/gateway/test/vtid-05133-community-mcp-tools.test.ts
AC-8: The migration creates `ai_connection_grants` (RLS, owner select only, no direct writes) and four SECURITY DEFINER functions that act only as `auth.uid()` and resolve the client from the pending Supabase authorization, never from a client-supplied id; its self-check fails the migration if RLS is off, anon can execute the grant function or `authenticated` has a direct write privilege.
  TEST: supabase/migrations/20261013150000_vtid_05133_ai_connection_grants.sql (self-check block, runs on apply)
AC-9: The delegation guard admits `/mcp/community*`; CORS lets only the OpenAI origins call `/mcp/community/chatgpt` and leaves `/mcp/community` on the generic allow-list.
  TEST: services/gateway/test/community-mcp.test.ts
