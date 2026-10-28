# VTID-04968 — AI delegated credentials operate Vitanaland only through the reviewed MCP surface

Owner decision 2026-10-08 (Gate 1, ChatGPT plugin plan). Sparring: `plan-sparring.md` (converged, 3 rounds). Part of the same plan: VTID-04969 (tool metadata), later VTIDs (reviewer sandbox, consent-screen redirect host + CTA, plugin package).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: global middleware `delegatedTokenGuard()` in `services/gateway/src/index.ts` (after `express.json`, before every router); `POST /mcp` gains a client approval step. No new public route.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/.well-known/oauth-protected-resource/mcp (staging, read-only metadata GET).

CURL_PROOF: staging metadata GET stays 200; an unsigned `POST /mcp` stays 401 (rejected probe, nothing written). Real assistant connections are the owner's check (they register an OAuth client and sign in).

OASIS_PROOF: every refusal emits `commerce.mcp.delegated_token_blocked` (guard) or `commerce.mcp.client_refused` (/mcp), vtid VTID-04968, actor = the user, rate limited to one per user and outcome per minute (guard); asserted in the jest suite.

MIGRATION: `20261008100000_vtid_04968_mcp_oauth_client_info.sql` (read-only SECURITY DEFINER function, service_role only). Must be applied (RUN-MIGRATION.yml) BEFORE the gateway that calls it is promoted, otherwise `/mcp` refuses every assistant (fail closed). Listed in the Gate 2 release contents.

## Acceptance criteria

AC-1: A token with a `client_id` claim, or whose session is delegated (`auth_session_is_delegated`), can reach only `/mcp`, `/.well-known/*`, `/alive`, `/health`; every other route answers 403 `DELEGATED_TOKEN_NOT_ALLOWED`, for reads and writes.
  TEST: services/gateway/test/vtid-04968-delegation-guard.test.ts
AC-2: An unknown session origin cannot write (403 on non-GET, including the submit and terms routes) while reads pass; `DELEGATION_GUARD_UNKNOWN=allow` and `DELEGATION_GUARD=log|off` are the switches; tokens from other issuers, service tokens and non-JWTs are untouched.
  TEST: services/gateway/test/vtid-04968-delegation-guard.test.ts
AC-3: The session lookup is cached for a minute and reuses the last verdict when the lookup fails.
  TEST: services/gateway/test/vtid-04968-delegation-guard.test.ts
AC-4: `/mcp` serves only OAuth clients whose registered redirect URIs are all https on an approved host (default chatgpt.com, chat.openai.com, claude.ai, claude.com; lookalike hosts and http refused); unknown client, lookup failure, claim-less delegated or unknown session are refused 403 `CLIENT_NOT_APPROVED` with an audit event and no tool runs.
  TEST: services/gateway/test/vtid-04968-delegation-guard.test.ts
  TEST: services/gateway/test/commerce-mcp.test.ts
AC-5: The guard is mounted after the body parser and before every router, and every write route of the partner-onboarding routers is listed in a standing test; terms/accept keeps its own `requestDelegation` check.
  TEST: services/gateway/test/vtid-04968-delegation-guard.test.ts
AC-6: Refusals are audited (rate limited per user) with client_id, path and verdict.
  TEST: services/gateway/test/vtid-04968-delegation-guard.test.ts

## Decisions taken (conservative choices inside the approved plan)
- Allow-list by redirect-URI host, not client_id: Supabase registers clients dynamically, so the id changes per connection.
- The guard classifies from the decoded, unverified token: it can only restrict; forged tokens fail the route's own verification.
- Unknown + GET is allowed so a lookup outage does not take down first-party reads.

## Not in this VTID
Reviewer sandbox (VTID TBD), consent-screen redirect host and "Connect with ChatGPT" CTA (vitana-v1), the plugin package and submission, the Phase 0 re-verification against OpenAI's live docs (blocked by the environment's network policy).
