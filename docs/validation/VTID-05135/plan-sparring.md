# Plan sparring record - VTID-05135

Plan hash (sha256 of the text between the plan markers, trimmed): `040929d1fe4d6e379a8e377a702e0e202155bdc3dcb2ddf05631d7e4380150b2`. Partner: plan-sparring-partner (read-only, independent), 2 rounds, CONVERGED (standard class). Owner approval: in session 2026-10-13, "yes, go ahead" in answer to the Gate 1 message (final plan, both rounds' findings, the files, the test plan). The gate is in log mode; the session is recorded here and in the ledger row.

Round 2 (partner, summary): F1-F5 closed; no new findings; verdict CONVERGED.

# Plan: see OpenAI's plugin scanner on our side, and make the ChatGPT sign-in challenge strictly RFC 6750

Change class: standard (gateway route on a public/auth surface)
Repo: exafyltd/vitana-platform
Scope (files): services/gateway/src/routes/commerce-mcp.ts, services/gateway/src/types/cicd.ts (one line: register the event type in `CicdEventType`, with a TEMPORARY comment), services/gateway/test/ (new test file commerce-mcp-probe-log.test.ts; one added assertion in vtid-04990-chatgpt-oauth.test.ts), docs/validation/<VTID>/*

<!-- plan:begin -->
## Problem (verified, 2026-10-13, read-only)
OpenAI's plugin portal shows the Vitanaland MCP server (`https://gateway.vitanaland.com/mcp/chatgpt`) as "Domain verified" but "Authorization unavailable". Its backend record for the draft says `mcp.type: "auth_not_configured"`, `oauth_client: null`, `supported_auth: null`; "Rescan"/"Retry" answer "The latest scan did not complete"; the Connect button sends no request at all. The scan runs on OpenAI's servers (the browser makes no request to our domain; the earlier browser-CORS 500 was a real bug, fixed by VTID-05079, but it was not the cause).
From outside, every probe I can make passes: an unauthenticated POST answers 401 with a `WWW-Authenticate: Bearer resource_metadata=...` challenge (also with no Accept header, no Content-Type, an OpenAI-style user agent); both metadata documents answer 200 JSON in ~0.4 s; Supabase's registration, authorize and token endpoints answer a preflight from `https://platform.openai.com` with `*`. We cannot see what the scanner actually sends or what it dislikes: plain 401 and 405 answers write no event or log we can read (`commerce.mcp.*` events exist only for approved-client refusals, tool calls and loopback approvals; a query for the last 40 minutes returned nothing).

## Change (two parts, both in `routes/commerce-mcp.ts`)
A. **A capped diagnostic event for unauthenticated probes.** A small function `auditProbe(req, path, status)` that emits one OASIS event `commerce.mcp.probe` (status `info`, source `commerce-mcp`, surface `api`) for a request that was answered WITHOUT a valid session on these endpoints only: `POST /mcp/chatgpt` with no bearer token or an unverifiable one (status 401), `GET|HEAD|DELETE /mcp/chatgpt` (405), and `GET` of the TWO ChatGPT-specific discovery documents (`/.well-known/oauth-protected-resource/mcp/chatgpt` and `/.well-known/oauth-authorization-server`, status 200). The general/Claude documents (`/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`, one shared handler) are NOT instrumented. Payload, all strings truncated to 200 characters and never containing a credential: `method`, `path`, `status`, `user_agent`, `origin` (the Origin header or null), `accept`, `content_type`, `has_authorization` (boolean only; the header value is never read into the payload), `jsonrpc_method` (the `method` field of an unauthenticated POST body only when it is a string of ≤ 64 characters, e.g. "initialize"; nothing else from the body), `forwarded_ip_class` is NOT recorded: no IP address, no cookie, no other header.
   Capped so it can never become a heartbeat or a flood (OASIS rule: polling is not an event): dedupe in memory per key `method|path|user_agent` once per 15 minutes (map cleared at 2,000 keys), and a hard ceiling of 60 probe events per hour per process (so up to 60 x the number of ECS tasks per hour overall; each task keeps its own counters and a deploy resets them; acceptable for a temporary diagnostic). `auditProbe` takes a `now` argument like `allowMcpCall`, so tests drive synthetic time. It is purely additive: it attaches a `res.on('finish')` listener from a small middleware that is registered BEFORE the handlers (`router.use('/chatgpt', probeMiddleware)` for the endpoint; the same middleware on the two discovery routes), so the listener exists before any `res.json()` call and the audit runs after the response has finished; it swallows its own errors (`.catch(() => undefined)`), and never changes a status code, header or body. Authenticated requests (a valid token, which is the normal assistant path) emit nothing new. It is a temporary diagnostic: the PR names a follow-up to remove it (the function, the middleware and the `CicdEventType` entry) once the scanner issue is understood; no table or migration.
B. **No error code on a challenge to a request that carried no credentials, on `/mcp/chatgpt` only.** RFC 6750 §3.1: if the request lacked any authentication information the resource server SHOULD NOT include an error code. Today a token-less POST gets `error="invalid_token", error_description="Sign in to Vitanaland..."`, which reads to a strict client as "a token was sent and rejected" and may be what the scanner mis-reads as "no authentication detected / authorization unavailable" (a hypothesis, not established; that is why A exists). For the ChatGPT path, a request with no bearer token now gets `WWW-Authenticate: Bearer resource_metadata="...", scope="email profile"` (no `error`, no `error_description`); the JSON body is unchanged. A request WITH a token that fails verification keeps `error="invalid_token"` and its description exactly as today. `/mcp` (Claude) is byte-for-byte unchanged (the existing VTID-04990 test pins its challenge).

## Tests (Jest, services/gateway/test/commerce-mcp-probe-log.test.ts, run by the gateway CI job)
Mount the real router with the same mocks the VTID-04990 test uses (OASIS emitter mocked):
1. token-less POST `/mcp/chatgpt` with `Authorization` absent → 401, header equals `Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp/chatgpt", scope="email profile"` (no `error`), body unchanged; one `commerce.mcp.probe` with the expected fields; a second identical request inside the window emits nothing more; a different user agent emits again;
2. POST with an invalid bearer → 401 with `error="invalid_token"` and the "expired or is not valid" description exactly as today; a probe event is emitted (has_authorization true, token value absent from the payload and the serialized event);
3. GET/HEAD/DELETE `/mcp/chatgpt` → 405 unchanged, probe emitted (status 405);
4. GET of each of the TWO ChatGPT discovery documents → 200 unchanged bodies, probe emitted; GET of `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` → 200, unchanged, NO probe event;
5. the ceiling, with synthetic time passed through `now` (no real waiting): with the dedupe window defeated by distinct user agents, no more than 60 events are emitted in an hour; the key map cannot grow past its cap;
6. a request with a VALID token emits no probe event (the existing client-allow-list tests stay green);
7. the emitter throwing or rejecting never changes the response;
8. `/mcp` (Claude): challenge unchanged (existing test) and no probe event for it (the diagnostic is ChatGPT-path and discovery only);
9. a long user agent is truncated; the payload contains no `authorization`, `cookie` or IP field (asserted by key list).

## Staging evidence
`staging-tests.json`: an `existing` entry `npx jest test/commerce-mcp-probe-log.test.ts test/vtid-04990-chatgpt-oauth.test.ts` (cwd services/gateway) plus read-only checks against the staging gateway: `GET /.well-known/oauth-authorization-server` (200) and `GET /.well-known/oauth-protected-resource/mcp/chatgpt` (200). After production deploy, the owner presses Rescan in OpenAI's portal; I then read the `commerce.mcp.probe` events (read-only SQL on `oasis_events`) to see what the scanner sent and what we answered.

## Rollout
PR -> CI -> merge -> staging deploy -> STAGING-VERIFY -> Gate 2 -> promote the verified commit pinned (env unchanged). Rollback: revert the PR (route code only; the events already written stay as harmless rows).

## Risks and what it accepts
- Part B changes the challenge text a ChatGPT-path client receives when it sends no token. Every spec-compliant client treats a 401 with `resource_metadata` as the cue to start OAuth, with or without an error code; the ChatGPT path has no production user other than the reviewer sandbox and the owner's own test account. If B makes things worse it is one revert.
- Part A stores user-agent strings and header values from anonymous callers (truncated, de-duplicated, capped at 60 an hour). No personal data beyond what a user agent contains; no IP, cookie or credential. It writes rows to `oasis_events` from an anonymous endpoint, bounded by the cap above.
- The dedupe and the ceiling live in each process, so the effective ceiling is 60 per task per hour and a deploy resets them.
- A and B ship together on purpose: B is the cheapest plausible fix, A tells us in one Rescan whether it was the cause or what the scanner really asks for.

## Non-goals
No change to `/mcp` (Claude), to OAuth endpoints (Supabase's), to the metadata documents, the plugin package, the allow-list, or CORS. No new table, env var, migration or route.
<!-- plan:end -->

## Planner responses (round 1)
- F1 [major]: ACCEPTED. Confirmed in the code: `types/cicd.ts:1132-1135` is a closed union and `CicdOasisEvent.type` uses it (`:1178-1180`), so an unregistered type would not compile. `types/cicd.ts` is now in the scope and gets `| 'commerce.mcp.probe'` with a TEMPORARY comment.
- F2 [minor]: ACCEPTED, option (a). Only the two ChatGPT-specific documents are probed; the general/Claude documents are not instrumented, and test 4 now asserts both that and the "three" wording is gone ("two").
- F3 [minor]: ACCEPTED. Added to the plan and to the risks: the effective ceiling is 60 per task per hour and a deploy resets it.
- F4 [minor]: ACCEPTED. The follow-up removes the function, the middleware and the union entry; the union line carries the TEMPORARY comment.
- F5 [minor]: ACCEPTED. `auditProbe` takes `now`; test 5 uses synthetic time and distinct user agents.
- Q1: answered under F2. Q2: a middleware registered before the handlers attaches `res.on('finish')`, so the listener always exists before `res.json()`; the audit runs after the response has finished, for the 405 handlers too.
