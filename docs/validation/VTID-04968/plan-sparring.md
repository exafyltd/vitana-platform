# Plan sparring record - VTID-04968 (shared with VTID-04969 and the later VTIDs of this plan)

Plan hash (sha256 of the text between the plan markers): `be5d0c1a962e57ec8e7885b02368302b9aaf3e6b2c38e4dec9609a74355525a4`. Partner: plan-sparring-partner (read-only, independent), 3 rounds, CONVERGED. Owner approved in session 2026-10-08 ("Gate 1 approved. Proceed with the plan, with these decisions: ..."). The gate was in log mode; the session is recorded here and in the ledger rows' metadata.

# Plan: Vitanaland as a public ChatGPT plugin (supplier onboarding), reusing the existing Commerce MCP

<!-- plan:begin -->
## Context (owner instruction 2026-10-08)
Publish Vitanaland as a public ChatGPT plugin for supplier onboarding: Install Vitanaland, Connect account, "Set up my business on Vitanaland". Reuse the existing gateway Commerce MCP (`POST /mcp`, services/gateway/src/routes/commerce-mcp.ts + services/commerce-mcp.ts), Supabase Auth as the OAuth server, and the Commerce service layer. No second backend, no second identity system. `services/vcaop-mcp` is a separate dev-only service and is not used.

## Owner decisions (Gate 1, 2026-10-08)
1. Reviewer account: Option A - a test-flagged OpenAI reviewer account and sandbox organization in the existing Supabase project, structurally isolated from member surfaces, Discover, supplier review queues, notifications, payouts/orders/referrals and public go-live; registered in `service_bot_accounts` and `notification_test_actors`; reviewer writes identifiable and resettable. No second Supabase project.
2. DCR stays enabled (Claude depends on it). Protect Vitanaland at the gateway: allow-list approved delegated MCP clients; delegated tokens reach `/mcp` and the required well-known metadata only; unknown delegation state fails closed; the consent screen shows the redirect host; blocked attempts are audited. Core invariant: AI delegated credentials can operate Vitanaland only through the reviewed MCP tool surface.
3. OpenAI organization verification is an account-side prerequisite confirmed by the owner; publication under the verified Vitanaland/EXAFY business identity.
Order: Phase 0 (re-verify every OpenAI requirement against the current official developer docs before packaging assumptions), then Phase 1 security/metadata, then Phase 2/3.

## Work items
Phase 1 (gateway, vitana-platform):
- VTID-04968: gateway-wide delegation guard (decodes the bearer; `client_id` claim or delegated session => only /mcp, /.well-known/*, /alive, /health; 'unknown' => no non-GET; 60 s session cache, stale-if-error; modes enforce|log|off); /mcp client approval by the hosts of the OAuth client's registered redirect URIs (RPC `mcp_oauth_client_info`), fail closed; OASIS audit of every refusal (rate limited per user); standing test enumerating the partner-onboarding write routes and keeping terms/accept behind requestDelegation.
- VTID-04969: all 9 tools declare readOnlyHint/destructiveHint/openWorldHint (+ idempotentHint) and `securitySchemes` (also mirrored in `_meta`); `/.well-known/openai-apps-challenge` (plain text, from env); tool-level `_meta["mcp/www_authenticate"]` challenge and unauthenticated discovery only after the live OpenAI spec is verified (Phase 0).
Phase 2 (vitana-v1): consent screen shows the redirect host; "Connect with ChatGPT" CTA behind one config constant, hidden until set, existing manual flow as fallback.
Reviewer sandbox: test-flagged account/org, excluded from member surfaces and review queues.
Phase 3: plugin package (plugin.json, .mcp.json, skills, assets), review test cases, submission.

## Test plan
Jest (gateway CI): delegation guard classification/paths/modes/audit, client allow-list, /mcp refusal, standing write-route check, tool metadata pins. Staging read-only manifest per VTID. No production writes.

## Change class
standard (auth, routes, migration).
<!-- plan:end -->

## Round 1 - findings (NOT CONVERGED)
- F1 blocker: REST `/submit` has no delegation check (only terms/accept does). ANSWER: accepted as a defect, rejected as a standalone blocker; same hole as F3, fixed at the root by the global guard.
- F2 blocker: a reviewer account writes to the one (production) Supabase project. ANSWER: accepted; owner decision at Gate 1 (Option A, sandbox tenant).
- F3 major: tokens are not audience-bound; a ChatGPT token works on every gateway REST route. ANSWER: accepted; global guard + /mcp client approval.
- F4 major: in-memory per-instance rate limit. ANSWER: accepted as a documented limitation; per-IP limit for unauthenticated requests; shared store deferred.
- F5 major: DPA / billing / results / tracking routes do not exist yet. ANSWER: accepted; standing route test + safe-by-default global guard.
- F6 major: open DCR lets any client register. ANSWER: accepted; owner kept DCR on; compensating control = guard + client approval + consent-screen redirect host.
- F7 minor: OpenAI docs unverified. ANSWER: accepted; Phase 0 gating step.
- F8 minor: unauthenticated initialize/tools/list is more invasive than "small". ANSWER: accepted; default keeps auth, relax only if the spec requires it.
- F9 minor: CORS for /.well-known. ANSWER: accepted as verification item. F10 minor: prompt-injection negative test case. ANSWER: accepted.

## Round 2 - findings
- F11 major: a guard using only the JWT `client_id` claim is weaker than requestDelegation (misses delegated sessions without the claim). ANSWER: accepted; both checks, 60 s cache.
- F12 minor: document the fail-open/fail-closed asymmetry. ANSWER: accepted (three-tier posture in delegation-guard.ts header). F13 minor: audit guard 403s. ANSWER: accepted (OASIS event, rate limited per user).

## Round 3 - findings
- F14 minor: the consent screen does not display the redirect host. ANSWER: accepted; Phase 2 work item.
- Verdict: CONVERGED. No open or disputed blocker or major.

## Planner notes during implementation (conservative choices)
- DCR creates a new client_id per connection, so the allow-list is by redirect-URI host (https only; chatgpt.com, chat.openai.com, claude.ai, claude.com; env COMMERCE_MCP_ALLOWED_REDIRECT_HOSTS), not by client_id.
- The guard decodes the bearer without verifying the signature because it can only restrict; only `authenticated` tokens from this project's Supabase issuer are looked up, so service, Cognito and other-project tokens are untouched.
- Phase 0 limitation: developers.openai.com and learn.chatgpt.com were blocked by the environment's network policy (proxy 403); requirements come from search excerpts of the official pages until the host is allowed.

## Owner approval
Approved by the owner in session 2026-10-08 (Gate 1), plan hash above.
