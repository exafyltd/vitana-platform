# VTID-05152 - the repo's Vitanaland plugin package matches the one under review

Owner decision 2026-10-13 ("yes, go ahead" at Gate 1 on the sparred plan). Sparring: `plan-sparring.md` (standard class, 2 rounds, CONVERGED).

Problem: the repo folder `integrations/chatgpt-plugin/vitanaland/` was the older layout while OpenAI's portal holds v6 (version 1.0.0, in review): `mcp.json` lacked the OAuth declaration, the legacy `.mcp.json` and `.codex-plugin/plugin.json` still existed, and the category was Productivity.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: no new route or mount; no route file changes.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/.well-known/oauth-protected-resource/mcp/chatgpt (staging, read-only GET; the gateway runtime is unchanged).

OASIS_PROOF: not applicable; packaging and a test only, no event is emitted or changed.

CURL_PROOF: the two staging discovery documents answer 200 (staging-tests.json).

## Acceptance criteria

AC-1: `mcp.json` declares one server `vitanaland-commerce`, `streamable-http`, the production URL, with `extensions["com.openai"].auth` = oauth, DCR, scopes email and profile; both `$schema` URLs are pinned.
  TEST: services/gateway/test/vtid-04980-chatgpt-plugin-package.test.ts
AC-2: `.mcp.json` and `.codex-plugin/` do not exist; category is "Business & Operations"; listing fields, legal URLs and the 512px assets are unchanged.
  TEST: services/gateway/test/vtid-04980-chatgpt-plugin-package.test.ts
AC-3: The skill and review-case tests are unchanged and green.
  TEST: services/gateway/test/vtid-04980-chatgpt-plugin-package.test.ts

## Accepted risk
The Codex plugin layout is removed; nobody installs the plugin from this folder. The v6 files were copied from the zip the owner uploaded, not retyped.

## Limits
Jest cannot run in the build session (registry blocked); CI is the first run. The edited test was syntax-checked with the TypeScript transpiler.
