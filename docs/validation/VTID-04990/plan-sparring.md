# Plan sparring record - VTID-04990

Plan hash (sha256 of the text between the plan markers): `ce4e8ed761bc37a16adfd116ff1a3764b6a8b888e51c6084e585b5f494f737b4`. Partner: plan-sparring-partner (read-only, independent, Claude Opus on Bedrock per CLAUDE.md rule 53), 2 rounds, CONVERGED (standard class). Owner approval: in session 2026-10-08, "approve B and loopback, go ahead" (given before the redesign), re-confirmed after the redesign by "go ahead" in answer to the revised plan being sent back to the same partner. The gate is in log mode; the session is recorded here and in the ledger row.


<!-- plan:begin -->
## Context (owner decision 2026-10-08: "approve B and loopback, go ahead")
Evidence from the live system (read-only, 2026-10-08 15:15 UTC):
- ChatGPT's desktop client (registers itself as client "Codex", redirect `http://127.0.0.1:<port>/callback/<id>`) completes consent, then Supabase `POST /oauth/token` returns 500 `HS256 is not supported for ID token signing`.
- The authorization it sent had `scope = "openid profile email phone offline_access"` - exactly Supabase's own `scopes_supported` from `/.well-known/oauth-authorization-server`. It ignored the narrower `scope="email profile"` in our 401 challenge and in our protected-resource metadata. `openid` makes Supabase mint an ID token, which the project (HS256 JWT secret) cannot sign. Claude avoids this because it follows our scope request (VTID-04882).
- Once the token exchange works, the next gate is `checkMcpClient` (`mcp-client-allowlist.ts`): every registered redirect URI must be https on an approved host, so a loopback `http://127.0.0.1` redirect is refused `client_not_approved`.
Core invariant (owner Gate 1, unchanged): AI delegated credentials operate Vitanaland only through the reviewed MCP tool surface.

## Design: a ChatGPT-only path, so the working Claude path is untouched
One switch, `COMMERCE_MCP_CHATGPT` (exact string `true`, default OFF, also requires `COMMERCE_MCP_ENABLED`). OFF -> every new route below answers 404 and the gateway behaves exactly as today. Everything that changes lives on a NEW resource path `/mcp/chatgpt`; `/mcp` (what Claude uses), its protected-resource metadata and its 401 challenge stay byte-for-byte identical whether the switch is on or off.

Changes (repo exafyltd/vitana-platform, gateway only, plus the plugin package URL):
1. `routes/commerce-mcp.ts`: when the switch is on,
   a. the MCP handler is also served at `POST /mcp/chatgpt` (same handler, same auth, same rate limit, same tool surface);
   b. `GET /.well-known/oauth-protected-resource/mcp/chatgpt` returns resource `${origin}/mcp/chatgpt`, `authorization_servers: [origin]`, `scopes_supported: [email, profile]`;
   c. `GET /.well-known/oauth-authorization-server` returns the shim document: `issuer` = gateway public origin; `authorization_endpoint`, `token_endpoint`, `registration_endpoint` still Supabase's; `scopes_supported: [email, profile]`; `response_types_supported: [code]`; `grant_types_supported: [authorization_code, refresh_token]`; `token_endpoint_auth_methods_supported: [none]`; `code_challenge_methods_supported: [S256]`; no `jwks_uri`, `userinfo_endpoint`, ID-token or claims fields;
   d. the 401 challenge on `/mcp/chatgpt` points `resource_metadata` at (b); the challenge on `/mcp` is unchanged.
2. `services/mcp-client-allowlist.ts`: `checkMcpClient` gets an `allowLoopback` option, true only for requests arriving on `/mcp/chatgpt` with the switch on. With it, a registered redirect URI is acceptable when it is `http:` and the host is exactly `127.0.0.1`, `[::1]` or `localhost` (any port, path); the rule stays "EVERY registered URI is acceptable"; anything else is refused. A client holding a loopback redirect is refused at `/mcp` (loopback never approved there). A rate-limited audit event `commerce.mcp.loopback_client_approved` (client_id, client_name, user) is emitted once per client per hour; `client_refused` payloads gain `client_name`. New event type in `types/cicd.ts`.
3. `AWS-STAGE-DEPLOY-GATEWAY.yml`: pin `COMMERCE_MCP_CHATGPT=true` on staging only (same lists where `COMMERCE_MCP_ENABLED` is pinned, lines ~1072 and ~1145). Production is not touched by workflow files: the prod task definition keeps the switch off until the owner approves activation; then the existing generic `env_overrides` input of `AWS-PROD-DEPLOY-GATEWAY.yml` (env-only mode) sets `{"COMMERCE_MCP_CHATGPT":"true"}`, and sets it `false` to roll back.
4. Plugin package (`integrations/chatgpt-plugin/vitanaland/mcp.json`, `.mcp.json`): URL -> `https://gateway.vitanaland.com/mcp/chatgpt`; the package test pins it; the owner re-uploads the zip ("Upload new version"). No other package change.
5. Tests/evidence: new `test/vtid-NNNNN-chatgpt-oauth.test.ts`:
   - switch OFF: `/mcp/chatgpt`, its metadata and the shim all 404; `/mcp` protected-resource metadata and 401 challenge byte-for-byte equal to today's; switch ON: `/mcp` metadata and challenge STILL identical (pinned);
   - shim ON: exact document, no `openid`, issuer = public origin, endpoints = Supabase's;
   - loopback: approved only on `/mcp/chatgpt` with the switch (`http://127.0.0.1:57859/callback/x`, `http://localhost:1/x`, `http://[::1]:2/y`); refused on `/mcp`; refused: mixed set (loopback + evil https host), `http://127.0.0.2`, `http://127.0.0.1.evil.com`, `https://127.0.0.1`, `http://localhost.evil.com`, switch off; existing claude.ai / chatgpt.com cases unchanged;
   - delegation guard: a delegated token reaches `/mcp/chatgpt` and `/.well-known/oauth-authorization-server`, and still nothing else;
   - `staging-tests.json`: read-only GETs of the three well-known documents on staging (structure only; hosts differ per env), unsigned `POST /mcp/chatgpt` -> 401 with the chatgpt resource_metadata, unsigned `POST /mcp` -> 401 with the original resource_metadata, plus the Jest file; evidence pack in `docs/validation/<VTID>/`.

## Rollout (nothing reaches production without the owner)
1. PR -> CI -> merge -> staging deploy (switch on) -> full STAGING-VERIFY green.
2. Gate 2 to the owner, stating plainly: deploy (inert, switch off in prod) AND the env flip that turns the ChatGPT path on, plus the plugin zip re-upload. Rollback = same env-only dispatch with `false`.
3. After the yes: promote the verified commit pinned to it, env-only deploy with the switch on, owner re-uploads the plugin and reconnects (the only real end-to-end test; ChatGPT can only be pointed at production). Claude's path never changes, so no Claude regression test is needed beyond the pinned byte-equality test; the owner may still reconnect Claude once for comfort.

## Security statement (explicit owner point)
Loopback approval is an intentional relaxation, limited to the `/mcp/chatgpt` path: that path accepts "any desktop app on the user's own machine that the user signs in and consents for", not only named assistants. Mitigations: loopback is never approved on `/mcp`; the consent screen shows the client name (the redirect-host line exists only in the held frontend commit, not in production); every client's first approval per hour is audited with its name; the delegated-token guard still confines such tokens to `/mcp*` and `/.well-known/*`; the switch kills the whole path. `client_name` is self-declared and not trusted.

## Out of scope
Supabase JWT signing-key migration (owner-only, platform-wide blast radius), a `/oauth/token` or `/oauth/authorize` proxy, frontend, reviewer account, deploy governance, the tool-level `mcp/www_authenticate` metadata. `/.well-known/openai-apps-challenge` already exists (VTID-04969) and is unchanged.
<!-- plan:end -->

Change class: standard (routes, auth surface, a workflow file). Scope: services/gateway/src/routes/commerce-mcp.ts, services/gateway/src/services/mcp-client-allowlist.ts, services/gateway/src/types/cicd.ts, .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml, integrations/chatgpt-plugin/vitanaland/{mcp.json,.mcp.json}, services/gateway/test/, docs/validation/<VTID>/.

## Round 1 - partner findings (summary)
F1 major: changing `authorization_servers` for all clients risks the working Claude integration. F2 major: shim issuer mismatch (RFC 8414) is the load-bearing, untested assumption; consider a `/oauth/token` proxy that strips `id_token`. F3 major: loopback approval is a security widening, needs explicit owner acknowledgement. F4 minor: pin that delegated tokens reach the new well-known path. F5 minor: name the env vars in the staging pins. F6 minor: note the existing openai-apps-challenge route. F7 minor: no change needed. Verdict: NOT CONVERGED.

## Planner responses (round 1)
- F1 ACCEPTED, and the design changed: the shim and its resource metadata exist only on a new path `/mcp/chatgpt`; `/mcp` metadata and challenge are untouched and pinned byte-for-byte by tests with the switch on and off. Q1/Q2 (does Claude validate issuer, when does it re-discover) no longer matter: Claude never sees the shim.
- F2 ACCEPTED in part. The issuer mismatch stays an explicit, stated assumption for ChatGPT, bounded by the switch (off -> only the ChatGPT path is affected, which does not work today anyway). The `/oauth/token` proxy is REJECTED: the 500 happens inside Supabase while minting the ID token (nothing is returned to strip), and the authorization-code token request carries no scope, so the token endpoint cannot be fixed from the response side; the request-side equivalent is an authorize-endpoint proxy that filters `openid`, which still needs our own AS metadata document (the same shim), plus PKCE/state handling - more moving parts for the same assumption.
- F3 ACCEPTED: the security statement is now in the plan; loopback is confined to `/mcp/chatgpt` (never approved on `/mcp`), audited per client, behind the switch. The owner already approved loopback in chat after being told any local app the user authorizes becomes an approved client; this plan restates it for Gate 1.
- F4 ACCEPTED: test added. F5 ACCEPTED: one switch, `COMMERCE_MCP_CHATGPT`, named in the staging pins. F6 NOTED: stated in Out of scope. F7: no change.
- Q3 answered under F2. Q4: Codex registered a brand-new client on every attempt (observed 14:57 and 15:14) and the plugin will point at a new resource URL, so there is no old cache to defeat; the owner re-uploads the plugin version.

## Round 2 - partner response (summary)
F1 closed (redesign puts the shim on /mcp/chatgpt only; /mcp pinned byte-for-byte). F2 acknowledged (issuer mismatch is an explicit assumption bounded to the ChatGPT path; the /oauth/token proxy rejection is sound: the 500 happens inside Supabase while minting, and the token request carries no scope). F3 closed (loopback confined to /mcp/chatgpt, owner acknowledgement recorded). F4, F5, F6, F7 closed. New: F8 minor (the 401 challenge on /mcp/chatgpt must point at the chatgpt resource metadata, checkMcpClient must be called with allowLoopback true, add a 405 catch-all), F9 minor (the new routes must check BOTH switches; the existing enabled() helper checks one). Q1: add router.post('/chatgpt') to the existing router rather than mount a second one. Verdict: CONVERGED, no open blocker or major.

## Planner responses (round 2)
- F8 ACCEPTED: `unauthorized()` takes a `chatgpt` flag; the handler is a factory `mcpPost(chatgpt)` registered at `/` and `/chatgpt`; a `router.all('/chatgpt')` 405 mirrors `/`.
- F9 ACCEPTED: `isChatgptPathEnabled()` / `chatgptEnabled()` check COMMERCE_MCP_ENABLED and COMMERCE_MCP_CHATGPT (exact `true`) for the three new routes and the handler.
- Q1: same router, `router.post('/chatgpt', ...)`.

## Deviation recorded during implementation
The plan said `client_refused` payloads gain `client_name`. Existing tests pin the exact refusal result `{ ok: false, reason }`, and the name is only known after a successful lookup, so the refusal payload gains `path` instead; the loopback-approval event carries `client_name`, which is where attribution is needed.

## Owner approval
Approved by the owner in session 2026-10-08 (see above), plan hash above.
