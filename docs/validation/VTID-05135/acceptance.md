# VTID-05135 - see OpenAI's plugin scanner on our side, and an RFC 6750 challenge on /mcp/chatgpt

Owner decision 2026-10-13 ("yes, go ahead" at Gate 1 on the sparred plan). Sparring: `plan-sparring.md` (standard class, 2 rounds, CONVERGED).

Problem: OpenAI's plugin portal shows "Authorization unavailable"; its backend record says `mcp.type: auth_not_configured`; Rescan answers "The latest scan did not complete". Every probe from outside passes (401 challenge, metadata documents 200, Supabase endpoints answer the portal's origin). Nothing on our side shows what the scanner sends: plain 401/405 answers write no event.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: no new route or mount. `commerce-mcp.ts` adds a small middleware in front of the existing handlers of `/mcp/chatgpt` and the two ChatGPT discovery documents.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/.well-known/oauth-authorization-server (staging, read-only GET).

OASIS_PROOF: a new, capped diagnostic event `commerce.mcp.probe` (one per method+path+user agent per 15 minutes, at most 60 an hour per process, no credential, IP or cookie). After the production deploy the owner presses Rescan in OpenAI's portal and the events are read with a read-only query on `oasis_events`.

CURL_PROOF: `POST /mcp/chatgpt` without a token returns 401 with `WWW-Authenticate: Bearer resource_metadata="...", scope="email profile"` (no error code); with a bad token the error code is kept; `POST /mcp` (Claude) is unchanged.

## Acceptance criteria

AC-1: A token-less POST on `/mcp/chatgpt` gets the plain challenge (no `error`, no `error_description`), the JSON body unchanged, and one `commerce.mcp.probe` event; a bad token keeps `error="invalid_token"` and its description; `/mcp` is unchanged.
  TEST: services/gateway/test/commerce-mcp-probe-log.test.ts
AC-2: `GET`/`DELETE` on `/mcp/chatgpt` (405) and the two ChatGPT discovery documents (200) are logged; the general/Claude documents and authenticated calls emit nothing.
  TEST: services/gateway/test/commerce-mcp-probe-log.test.ts
AC-3: The log is capped (15-minute dedupe per key, 60 an hour per process, key map bounded), clipped to 200 characters, carries no credential, cookie or IP, and a failing emitter never changes a response.
  TEST: services/gateway/test/commerce-mcp-probe-log.test.ts
AC-4: The existing ChatGPT OAuth suite stays green (the `/mcp` challenge is pinned there byte for byte).
  TEST: services/gateway/test/vtid-04990-chatgpt-oauth.test.ts

## Accepted risk
Part B changes the challenge text for token-less requests on the ChatGPT path only. Part A writes up to 60 anonymous-caller records an hour per task (user agent and a few header values, clipped). Both are temporary diagnostics; rollback is a revert.

## Limits
Jest cannot run in the build session (registry blocked); CI is the first run. The three changed files were syntax-checked with the TypeScript transpiler.
