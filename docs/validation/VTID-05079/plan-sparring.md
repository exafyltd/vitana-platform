# Plan sparring record - VTID-05079

Plan hash (sha256 of the text between the plan markers): `6f3c2a5ea1fab24fd9c1e72a6a57d8651b84a4ea26340e3a079b8821b6b690ea`. Partner: plan-sparring-partner (read-only, independent, Claude Opus on Bedrock per CLAUDE.md rule 53), 2 rounds, CONVERGED (standard class). Owner approval: in session 2026-10-12, "yes" in answer to the Gate 1 message (final plan, both rounds' findings, the files, the test plan). The gate is in log mode; the session is recorded here and in the ledger row.

Round 2 (partner, summary): F1-F6 closed; no new blocker or major findings; verdict CONVERGED.


Change class: standard (gateway middleware on a public/auth surface)
Repo: exafyltd/vitana-platform
Scope (files): services/gateway/src/middleware/cors.ts, services/gateway/test/ (new test file), docs/validation/<VTID>/*

<!-- plan:begin -->
## Problem (verified live, 2026-10-12 11:50 UTC, read-only requests to production)
The OpenAI plugin portal shows the MCP server as "Domain verified" but "Authorization unavailable", its Connect button does nothing, and no request from it has reached our logs (no OAuth client registered, no `commerce.mcp.*` event, no `/auth/v1/oauth/*` call in the last 40 minutes).
Cause, reproduced from outside: the gateway answers every request that carries an `Origin` header from a browser origin that is not on `ALLOWED_ORIGINS` / `ALLOWED_ORIGIN_PATTERNS` with an HTML **500** and no CORS headers (`middleware/cors.ts:57-65`: the `origin` callback calls `callback(new Error("Not allowed by CORS"))`, which Express turns into a 500). Measured on production:
- `GET /.well-known/oauth-authorization-server` with `Origin: https://platform.openai.com` -> 500; `https://chatgpt.com` -> 500; `https://claude.ai` -> 500; `https://example.com` -> 500; `https://vitanaland.com` -> 200.
- The same URL without an Origin header -> 200 with the correct document (checked also for `/.well-known/oauth-protected-resource/mcp/chatgpt` and `/.well-known/openai-apps-challenge`). Preflights (`OPTIONS`) with those origins -> 500.
OpenAI's portal runs in the browser (`platform.openai.com`) and reads our discovery documents from there, so it gets a 500 and reports "Authorization unavailable". Claude is unaffected because it calls server-side without an Origin header, which is why the Claude path has always worked. Domain verification passed because the token fetch is made by OpenAI's servers.

## Change
All of it lives inside `setupCors` in `middleware/cors.ts` (`index.ts` is NOT touched; it keeps calling `setupCors(app)` at line 568). `setupCors` registers ONE wrapper middleware, `app.use(discoveryCorsOrGeneric)`, **before** the existing `app.use(cors(corsOptions))` and `app.options('*', cors(corsOptions))` lines (Express runs middleware in registration order). The wrapper decides per request: for a request whose path matches the two rules below it applies `publicDiscoveryCors` and does NOT call the generic handler (so the generic handler's 500 can never fire for those paths); for every other request it just calls `next()`, and the generic handlers behave exactly as today. The `OPTIONS` answer is explicit code (`res.sendStatus(204)` after setting the headers), not the `cors` package default. Exact path matching: `req.path` equal to `/mcp/chatgpt`, or starting with `/.well-known/`; no sub-paths or look-alikes of `/mcp/chatgpt`.
1. **Discovery documents: `GET`, `HEAD`, `OPTIONS` on `/.well-known/*`** — any origin (`Access-Control-Allow-Origin: *`), no credentials. These documents (`oauth-protected-resource*`, `oauth-authorization-server`, `openai-apps-challenge`) are already publicly readable without authentication (their URLs are advertised in the 401 challenge, and the challenge token is meant to be served publicly); a wildcard is the normal setting for them and no cookie is involved.
2. **The ChatGPT MCP endpoint `POST`/`OPTIONS /mcp/chatgpt`** (the path introduced in VTID-04990, never `/mcp`) — only the OpenAI origins `https://platform.openai.com` and `https://chatgpt.com`, reflected exactly (never `*`), `Vary: Origin`, allowed headers `Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id`, exposed header `WWW-Authenticate` (the 401 challenge carries the metadata pointer a browser client must read), `credentials` off. Any other origin on this path keeps today's behaviour (the generic handler).
Preflight `OPTIONS` on those paths is answered `204` with the headers above; other paths and methods are untouched and flow to the existing handler byte-for-byte. `/mcp` (Claude's path), every `/api/*` route and the Command Hub keep the existing allow-list and its 500 for unknown origins.
No change to authentication: `/mcp/chatgpt` still requires a valid bearer token; CORS only lets a permitted browser origin read the response.

## Tests (Jest, services/gateway/test/commerce-mcp-cors.test.ts, run by the gateway CI job)
Mount `setupCors` on a small express app with stub routes for the real paths:
1. `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/mcp/chatgpt`, `/.well-known/openai-apps-challenge` with `Origin: https://platform.openai.com` -> 200, `Access-Control-Allow-Origin: *`; same with `https://example.com` and with no Origin (unchanged);
2. `OPTIONS` preflight on a well-known path from `https://platform.openai.com` -> 204 with the allow headers;
3. `/mcp/chatgpt`: preflight from each of the two OpenAI origins -> 204, the origin reflected, `Vary: Origin`, `Authorization` in allowed headers, `WWW-Authenticate` exposed, never `*`; a POST from `https://platform.openai.com` reaches the handler and the response carries the reflected origin; a POST from `https://example.com` still -> 500 "Not allowed by CORS" (unchanged);
4. `/mcp` from `https://platform.openai.com` and `https://claude.ai` is still 500 (Claude's path unchanged), and its allowed origin `https://vitanaland.com` still passes;
5. a normal API path (`/api/v1/x`) from `https://platform.openai.com` is still 500 (nothing else widened), and from an allowed origin still 200 with the existing headers;
6. a path that only starts with the same text (`/.well-known-evil`, `/mcp/chatgptx`, `/mcp/chatgpt/extra`) is NOT covered.

## Staging evidence
`staging-tests.json`: an `existing` entry `npx jest test/commerce-mcp-cors.test.ts` (cwd services/gateway) plus read-only GETs of `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource/mcp/chatgpt` (status 200; no Origin header, as the harness sends none). After deploy the same checks are repeated by hand against production with `Origin: https://platform.openai.com` (read-only GETs) as the post-publish check.

## Rollout
PR -> CI -> merge -> staging deploy -> STAGING-VERIFY -> Gate 2 -> promote the verified commit pinned (env unchanged). Then the owner presses Connect in the portal again. Rollback: revert the PR (middleware only; no data).

## Risks and what it accepts
- `Access-Control-Allow-Origin: *` on three public discovery documents lets any web page read them. They are already public and unauthenticated (their URLs are advertised in the 401 challenge); CORS adds no new access.
- `/mcp/chatgpt` becomes readable by browser pages on two OpenAI origins; a bearer token is still required for any data. A malicious page on those origins would need a victim's token, which it cannot obtain from CORS.
- Not widened: `/mcp`, `/api/*`, the Command Hub, cookies, credentials.

## Non-goals
No change to the allow-list for the app's own APIs; no change to OAuth endpoints (Supabase's); no change to the plugin package or its listing text.
<!-- plan:end -->


## Planner responses (round 1)
- F1 [major]: ACCEPTED. The scope is `cors.ts` (all logic inside `setupCors`) and the new test file; `index.ts` is untouched (stated in the plan).
- F2 [major]: ACCEPTED. The plan now states that the wrapper is registered inside `setupCors` before the existing `app.use(cors(corsOptions))`, and that it bypasses the generic handler for the two path rules.
- F3 [minor]: ACCEPTED. `https://chat.openai.com` dropped; two origins remain (`platform.openai.com`, `chatgpt.com`).
- F4 [minor]: ACCEPTED. The 204 is explicit code, asserted in the tests.
- F5 [minor]: ACCEPTED. Wording changed ("already publicly readable without authentication").
- F6 [minor]: NOTED, no change.
- Q1: inside `setupCors`, before the generic handler. Q2: exact `req.path` match, no trailing-slash or sub-path variants; test 6 pins the look-alikes as not covered.
