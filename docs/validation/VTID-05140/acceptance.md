# VTID-05140 - log every scanner request under /mcp and /.well-known (diagnostic part 2 of VTID-05135)

Owner decision 2026-10-13 ("yes, go ahead" at Gate 1 on the sparred plan). Sparring: `plan-sparring.md` (standard class, 2 rounds, CONVERGED).

Problem: OpenAI's scanner (`Python/3.14 aiohttp/3.14.4`) reads `POST /mcp/chatgpt` (401) and the two ChatGPT discovery documents (200, 200) and then stops without registering a client; the log only covers those exact paths and statuses, so any other request it makes (a 404 for example) is invisible.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: no new route or mount. `commerce-mcp.ts` adds a first middleware to the existing `/mcp` router and the existing `/.well-known` router (mounted at services/gateway/src/index.ts:1236-1237, unchanged).

FINAL_URL: https://preview-aws-gateway.vitanaland.com/.well-known/oauth-authorization-server (staging, read-only GET).

OASIS_PROOF: the existing capped diagnostic event `commerce.mcp.probe` (no new event type): one row per method+path+user agent per 15 minutes, at most 60 an hour per process; after the production deploy the owner presses Rescan and the rows are read with a read-only query on `oasis_events`.

CURL_PROOF: after deploy, `GET /.well-known/openid-configuration` with a `Python aiohttp` user agent still answers 404 exactly as before; a Rescan in OpenAI's portal produces `commerce.mcp.probe` rows for every request the scanner makes.

## Acceptance criteria

AC-1: A scanner-shaped user agent (`aiohttp|openai|chatgpt|python`) is logged on any path and status under `/mcp/*` and `/.well-known/*`, including unrouted 404s; other user agents keep the exact-path rule; `codex` is not scanner-shaped.
  TEST: services/gateway/test/commerce-mcp-probe-log.test.ts
AC-2: Every probe row carries `content_length`, `header_names` (names only, pattern-checked, at most 40), `mcp_protocol_version` and `response_content_type`; no header value, credential, cookie or IP is stored.
  TEST: services/gateway/test/commerce-mcp-probe-log.test.ts
AC-3: A request with an Authorization header that ends below 400 is never logged; the cap and dedupe apply; no answer (status, headers, body) differs between a scanner user agent and any other.
  TEST: services/gateway/test/commerce-mcp-probe-log.test.ts
AC-4: The VTID-05135 behaviour and the existing ChatGPT OAuth suite stay green.
  TEST: services/gateway/test/vtid-04990-chatgpt-oauth.test.ts

## Accepted risk
A bot with "python" in its user agent can use up the hourly budget for that hour (one row per path per 15 minutes each). Header names (not values) are stored, pattern-bound and capped. Requests answered by the community MCP's own well-known router are not seen (deliberate). Temporary: removed with VTID-05135's diagnostic in one follow-up.

## Limits
Jest cannot run in the build session (registry blocked); CI is the first run. The two changed files were syntax-checked with the TypeScript transpiler.
