# VTID-04969 — Commerce MCP tool metadata for the OpenAI plugin review

Owner decision 2026-10-08 (Gate 1). Sparring: `plan-sparring.md` (shared with VTID-04968).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: `GET /.well-known/openai-apps-challenge` on the existing well-known router; tool descriptors change in `tools/list` (`POST /mcp`).

FINAL_URL: https://preview-aws-gateway.vitanaland.com/.well-known/oauth-protected-resource/mcp (staging, read-only).

CURL_PROOF: staging metadata GET stays 200; `/.well-known/openai-apps-challenge` answers 404 until `OPENAI_APPS_CHALLENGE_TOKEN` is set (the token comes from the OpenAI portal at submission time).

OASIS_PROOF: unchanged — every tools/call still emits `commerce.mcp.tool_called`.

## Acceptance criteria

AC-1: All 9 tools set `readOnlyHint`, `destructiveHint` and `openWorldHint` as explicit booleans; only the two reads are read-only, none is destructive, only `check_verification` and `connect_store` are open-world.
  TEST: services/gateway/test/vtid-04969-commerce-mcp-openai-metadata.test.ts
  TEST: services/gateway/test/vtid-04941-commerce-mcp-automation.test.ts
AC-2: Every tool declares `securitySchemes: [{ type: 'oauth2', scopes: ['email','profile'] }]`, mirrored in `_meta`; `openid` stays out; `tools/list` serves the same descriptors.
  TEST: services/gateway/test/vtid-04969-commerce-mcp-openai-metadata.test.ts
AC-3: `/.well-known/openai-apps-challenge` serves exactly `OPENAI_APPS_CHALLENGE_TOKEN` as text/plain, 404 when unset, independent of the MCP switch.
  TEST: services/gateway/test/vtid-04969-commerce-mcp-openai-metadata.test.ts

## Decisions taken
- `destructiveHint: false` for update_business: it overwrites draft data another call restores; the one change that restarts a passed verification is gated by `confirmed`. Revisit if OpenAI's live guidance says otherwise (Phase 0).
- `submit_for_verification` is not open-world: it triggers Vitanaland's own review.

## Deferred until Phase 0 can read the live OpenAI docs (blocked by the environment's network policy)
Tool-level `_meta["mcp/www_authenticate"]` challenge on a tool call without a token, and unauthenticated `initialize`/`tools/list`. The plugin package (plugin.json, .mcp.json, skills, assets) and its review test cases.
