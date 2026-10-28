# VTID-05079 — OpenAI's plugin portal can read our OAuth discovery documents and the ChatGPT MCP endpoint (CORS)

Owner decision 2026-10-12 ("yes" at Gate 1 on the sparred plan). Sparring: `plan-sparring.md` (standard class, 2 rounds, CONVERGED).

Problem (measured on production, read-only): the portal's MCP tab shows "Domain verified" but "Authorization unavailable" and Connect does nothing; no request reaches our logs. The gateway answers any browser Origin that is not on its allow-list with an HTML 500 (`middleware/cors.ts`): `GET /.well-known/oauth-authorization-server` with `Origin: https://platform.openai.com` or `https://chatgpt.com` returned 500, with no Origin header 200. Claude is unaffected (server-side calls carry no Origin).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: no new route or mount. `setupCors` (called at services/gateway/src/index.ts:568, unchanged) now registers a path-specific wrapper before the generic cors handler.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/.well-known/oauth-authorization-server (staging, read-only GET).

OASIS_PROOF: not applicable. The change only adds CORS response headers on existing read-only discovery documents and an existing authenticated endpoint; it changes no state and takes no decision (no event is emitted by design).

CURL_PROOF: after deploy, `GET /.well-known/oauth-authorization-server` with `Origin: https://platform.openai.com` returns 200 with `Access-Control-Allow-Origin: *`; `OPTIONS /mcp/chatgpt` with `Origin: https://platform.openai.com` returns 204 with that origin reflected; `POST /mcp` with the same origin is still refused (500) and `https://example.com` on `/mcp/chatgpt` is still refused.

## Acceptance criteria

AC-1: `GET`/`HEAD`/`OPTIONS` on `/.well-known/*` return `Access-Control-Allow-Origin: *` (no credentials) for any origin; the preflight is an explicit 204; a POST on a well-known path from a stranger is still refused.
  TEST: services/gateway/test/commerce-mcp-cors.test.ts
AC-2: `/mcp/chatgpt` answers a preflight 204 and sets the response origin only for `https://platform.openai.com` and `https://chatgpt.com` (reflected exactly, `Vary: Origin`, `WWW-Authenticate` exposed, never `*`); a POST from OpenAI reaches the handler (401 without a token); any other origin, or no origin, keeps today's behaviour.
  TEST: services/gateway/test/commerce-mcp-cors.test.ts
AC-3: Nothing else is widened: `/mcp` (Claude), an `/api/*` path and the existing allow-list behave as before (OpenAI's origin still 500, allowed origins unchanged), and look-alike paths (`/mcp/chatgptx`, `/mcp/chatgpt/extra`, `/.well-known-evil`) are not covered.
  TEST: services/gateway/test/commerce-mcp-cors.test.ts
AC-4: The existing CORS suite is unchanged and green (allow-list, credentials disabled, preflight for allowed origins, 500 for a blocked origin).
  TEST: services/gateway/test/middleware/cors.test.ts

## Accepted risk
Any web page can read three public, unauthenticated discovery documents; two OpenAI sites can read the responses of `/mcp/chatgpt`, which still requires a bearer token for any data. No credentials, no cookies, `/mcp` and `/api/*` untouched.

## Limits
Jest cannot run in the build session (registry blocked); CI is the first run. The wrapper logic was exercised locally against a stubbed router and CORS package (12 cases: all matched the plan). The real end-to-end proof is the owner pressing Connect in OpenAI's portal after the production publish.
