# Plan sparring record - VTID-05140

Plan hash (sha256 of the text between the plan markers, trimmed): `d6ed5e74ff8d7f0629b4a79e7455b2ca92f74fd290fdee144974d6dbe9722b37`. Partner: plan-sparring-partner (read-only, independent), 2 rounds, CONVERGED (standard class). Owner approval: in session 2026-10-13, "yes, go ahead" in answer to the Gate 1 message (final plan, both rounds' findings, the files, the test plan). The gate is in log mode; the session is recorded here and in the ledger row.

Round 2 (partner, summary): F1-F4 closed; no new findings; verdict CONVERGED.

# Plan: see every request OpenAI's plugin scanner makes to our MCP and discovery paths (diagnostic, part 2)

Change class: standard (gateway route on a public/auth surface)
Repo: exafyltd/vitana-platform
Scope (files): services/gateway/src/routes/commerce-mcp.ts, services/gateway/test/commerce-mcp-probe-log.test.ts (extend the VTID-05135 test file), docs/validation/<VTID>/*

<!-- plan:begin -->
## Problem (verified in production on 2026-10-13, read-only)
OpenAI's plugin portal keeps answering "The latest scan did not complete" and `mcp.type: auth_not_configured`. VTID-05135 added a capped `commerce.mcp.probe` event for unauthenticated hits on `POST|GET|DELETE /mcp/chatgpt` and the two ChatGPT discovery documents. At 10:04:18 UTC it recorded the scanner (`user_agent: "Python/3.14 aiohttp/3.14.4"`, no Origin, `Accept: */*`):
1. `POST /mcp/chatgpt`, `content_type: "application/octet-stream"`, no JSON-RPC body (`jsonrpc_method: null`) -> we answered 401 with the sign-in challenge;
2. `GET /.well-known/oauth-protected-resource/mcp/chatgpt` -> 200;
3. `GET /.well-known/oauth-authorization-server` -> 200;
then nothing more. No OAuth client was registered in Supabase (`auth.oauth_clients` has no row from the last three hours), so the scanner stopped before registration. The same documents let OpenAI's own Codex client (`codex-mcp-client/0.162.0-alpha.2`, 10:03:37) sign in and be approved (`commerce.mcp.loopback_client_approved`), so our documents work for a real OpenAI client.
What we cannot see: any other request the scanner made. Part 1 logs only the exact paths above and only the statuses 401, 405 and 200. A request that we answer with a 404 (for example `/.well-known/openid-configuration`, `/.well-known/oauth-authorization-server/mcp/chatgpt`, a `/mcp/...` sub-path, a `POST /register`) writes nothing, and neither does a request whose body or headers might explain the stop (the first POST had no JSON body; we log no header names).

## Change (all in `routes/commerce-mcp.ts`; `index.ts` untouched, no new route or mount)
A. **Scanner-shaped requests are logged on every path and status under our two prefixes.** A middleware `scannerProbeMiddleware`, registered with `router.use(...)` FIRST in the `/mcp` router and `wellKnownRouter.use(...)` FIRST in the `/.well-known` router (both already mounted in `index.ts:1236-1237`), so it sees every request below `/mcp/*` and `/.well-known/*` including the ones no route answers (Express's own 404). It attaches a `res.on('finish')` listener before any handler runs and, when the request's `User-Agent` matches `/aiohttp|openai|chatgpt|python/i`, calls the existing `auditProbe` with the final status, whatever it is (200, 3xx, 4xx, 5xx). Requests with any other user agent keep exactly Part 1's rule (only the listed paths and statuses). The event type stays `commerce.mcp.probe` (already registered), so `types/cicd.ts` is not touched. On routes where Part 1's per-status `probeMiddleware` is also attached, both listeners fire; the scanner middleware registers first, and `shouldAuditProbe` makes the second call a no-op (same key), so there is never a double row. The existing cap is unchanged and shared: one event per method+path+user agent per 15 minutes, at most 60 an hour per process; a request that has an `Authorization` header and ends below 400 is never logged.
B. **Four more fields in every probe payload, none of them a credential.**
   - `content_length`: the `Content-Length` header, clipped to 20 characters (the first POST had no JSON body; this tells us whether it had any body at all);
   - `header_names`: the lower-cased NAMES of the request headers only (never a value), each matching `^[a-z0-9-]{1,40}$`, at most 40 names, so we can see for example an `mcp-protocol-version` or `x-openai-*` header the scanner sends; the `authorization`, `cookie` and `x-forwarded-for` names may appear as names, their values are never read;
   - `mcp_protocol_version`: the value of the `Mcp-Protocol-Version` header clipped to 32 characters (a version date, not a secret);
   - `response_content_type`: the `Content-Type` of our answer, clipped to 80 characters.
   The payload still carries no IP address, cookie, token or body text. Existing fields are unchanged.
C. Nothing about any response changes: the middleware only reads the request and the finished response, runs after the response has finished, swallows its own errors, and never calls `res.send`/`res.status`.

## Tests (Jest, extend services/gateway/test/commerce-mcp-probe-log.test.ts)
Mount the real router and `wellKnownRouter` with the mocks of the existing file:
1. a request from user agent `Python/3.14 aiohttp/3.14.4` to an unknown path under `/.well-known/` (for example `/.well-known/openid-configuration`) answers 404 as before and emits one probe with `status: 404`, `path` and the four new fields;
2. the same for `POST /mcp/chatgpt/anything` and `POST /mcp/unknown` (404 or 405, whatever the router answers today is unchanged) and for `GET /.well-known/oauth-protected-resource` (200), the general Claude document, when the scanner UA is used;
3. the same unknown paths with the default supertest user agent emit NOTHING (Part 1's exact-path rule is unchanged); the existing "general / Claude documents emit nothing" test keeps passing;
4. `header_names` carries names only: send `Authorization: Bearer secret-token-value`, `Cookie: session=abc`, `X-Forwarded-For: 203.0.113.9` and assert the names are listed and the three values appear nowhere in the serialized event; the list is capped at 40 and rejects names that do not match the pattern;
5. `content_length` and `mcp_protocol_version` are recorded and clipped; `response_content_type` is recorded as the answer's actual content type (asserted equal to what the response carried, JSON for the 401; for an unrouted 404 only that it is a clipped string or null, so the test does not depend on Express's default error page);
6. an authenticated call with a valid token and a scanner user agent (status 200) emits nothing; an authenticated call that ends 4xx is logged;
7. the existing key-list assertion is updated to the new exact key set; the cap tests (60 an hour, 15-minute dedupe, bounded map, failing emitter) still pass, including with the scanner user agent;
8. every answer in tests 1-2 equals the answer without the middleware (status, headers, body) so the diagnostic provably changes nothing.

## Staging evidence
`staging-tests.json`: an `existing` entry `npx jest test/commerce-mcp-probe-log.test.ts test/vtid-04990-chatgpt-oauth.test.ts` (cwd services/gateway) plus two read-only GETs of the staging discovery documents (200). After the production deploy the owner presses Rescan once more; the new events are read with read-only SQL on `oasis_events`.

## Rollout
PR -> CI -> merge -> staging deploy -> STAGING-VERIFY -> Gate 2 -> promote the verified commit pinned. Rollback: revert the PR. The whole `commerce.mcp.probe` diagnostic (Part 1, this part, the `types/cicd.ts` entry) is removed in one follow-up VTID once the scanner is understood.

## Risks and what it accepts
- More anonymous-caller rows can be written to `oasis_events`: still at most 60 an hour per process, deduplicated per method+path+user agent per 15 minutes, and now only for scanner-shaped user agents on paths under `/mcp` and `/.well-known` (plus Part 1's exact paths for everyone). A bot that sets a user agent containing "python" can fill the 60-an-hour budget and hide the scanner for that hour: accepted for a temporary diagnostic; the dedupe limits one bot to one row per path.
- Header names (not values) are stored for these rows. A header name can in principle be chosen by the caller; the pattern and the 40-name cap bound it, and no value is stored.
- The scanner middleware sits in the commerce routers only. A request answered by the community MCP's own `/.well-known` router (`communityWellKnownRouter`, mounted before this one at `index.ts:1234`; its two community ChatGPT documents) is not captured: deliberate, the plugin under review is the Commerce one.
- The user-agent filter does not include `codex` (OpenAI's own approved desktop client, whose exact-path hits are already logged by Part 1); a Python HTTP library does match and shares the cap, as stated above.
- No change to any response, status, header, body, route or authentication.

## Non-goals
No change to the documents, to OAuth, to Supabase, to the plugin package, to CORS or to Claude's path; no attempt to fix the scanner failure in this change (we do not yet know its cause); no new event type, table, env var or migration.
<!-- plan:end -->

## Planner responses (round 1)
- F1 [minor]: ACCEPTED. Added to the risks: requests answered by the community `/.well-known` router (`index.ts:1234`) are not captured, deliberately. Q1: the scope is deliberately commerce-only; the plugin under review is the Commerce one and the community MCP has its own, separate ChatGPT path.
- F2 [minor]: ACCEPTED. Section A now states that both listeners fire on routes that already carry Part 1's `probeMiddleware`, that the scanner middleware registers first, and that `shouldAuditProbe` deduplicates by key so there is never a double row.
- F3 [minor]: ACCEPTED, and the regex changed: `codex` is removed (`/aiohttp|openai|chatgpt|python/i`). The approved Codex client's exact-path hits stay covered by Part 1; the risks name the remaining Python-library case.
- F4 [minor]: ACCEPTED. Test 5 asserts the recorded `response_content_type` equals what the response carried for the JSON 401, and for the unrouted 404 only that it is a clipped string or null; it no longer assumes Express's default error page.
- Q2: yes, intentional. The four new fields are written for every probe row, including Part 1's non-scanner rows; they are request metadata only (names, lengths, a version string, our own content type), never a credential or a body.
