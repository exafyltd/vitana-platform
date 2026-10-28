# VTID-04882 — Plan Sparring record

- Gate: Plan Sparring Gate (VTID-04868), session fallback (no gateway sparring
  record: this session has neither GATEWAY_SERVICE_TOKEN nor an exafy_admin login;
  the record is mirrored in the vtid_ledger row's metadata.plan_sparring).
- Plan hash (sha256 of the text between the plan markers): 471bab882dc5b1fbf7ab410e5c04c65cfb6967319ed390446bec3faf82f39b79
- Partner: plan-sparring-partner agent (read-only), 2 rounds.
- Verdict: converged (round 1: 1 major, 4 minor, all accepted; round 2: all closed, no new findings).
- Owner approval: in chat, 2026-10-05 ("yes, go ahead").

## Final plan, round-1 findings and planner responses

# Plan: Commerce MCP advertises its scopes so assistants stop requesting `openid`

<!-- plan:begin -->
## Problem (evidence)
Real Claude connection to the staging Commerce MCP endpoint (gateway VTID-04847,
`https://preview-aws-gateway.vitanaland.com/mcp`) on 2026-10-05 08:19/08:20 UTC, Supabase auth logs
(project inmkhvwdcuyhnxkgfvsb, read-only query):
- `/.well-known/oauth-authorization-server/auth/v1` 200 → `/oauth/clients/register` 201 →
  `/oauth/authorize?...&scope=openid+profile+email+phone+offline_access` 302 → consent page
  (`vitanaland.com/commerce/connect/authorize`) GET details 200, POST consent approve 200 →
  `POST /oauth/token` **500** with auth error `"HS256 is not supported for ID token signing"`.
- Claude requested Supabase's full `scopes_supported` list because our RFC 9728 protected-resource
  metadata (`GET /.well-known/oauth-protected-resource[/mcp]`) has no `scopes_supported` and our 401
  `WWW-Authenticate` challenge carries no `scope`. Supabase mints an ID token whenever `openid` is
  requested; ID tokens need an asymmetric signing key; the project signs with the legacy HS256 secret.

## Goal
Get the assistant connection through the token exchange WITHOUT changing Supabase signing keys
(that path needs the JWKS env on both gateways, a prod gateway deploy and a review of 32
`verify_jwt=true` edge functions — kept as the fallback, owner decision 2026-10-05).

## Change (gateway only, staging-only effect)
In `services/gateway/src/routes/commerce-mcp.ts`:
1. Protected-resource metadata gains `scopes_supported: ["email", "profile"]`.
2. The 401 challenge gains `scope="email profile"` in `WWW-Authenticate`
   (`Bearer resource_metadata="…", scope="email profile", error="invalid_token", error_description="…"`;
   `scope` placed before `error`, order is not significant per RFC 6750 / RFC 9728).
   MCP authorization spec (scope selection): clients use the challenge's `scope`, else the
   resource metadata's `scopes_supported`. Either way the request carries no `openid`, so Supabase
   issues access + refresh tokens and no ID token.
Why these scopes: Supabase supports only `openid email profile phone` (no custom scopes); an ID
token is minted only when `openid` is requested (Supabase OAuth 2.1 Flows guide; the same guide
documents `email` as the default scope, which this fix does not rely on); refresh tokens are issued
without `offline_access`; the gateway uses
only the access token (`verifyAndExtractIdentity`, unchanged). `phone` is not needed.
Nothing else changes: no auth logic, no token verification change, no new route, no env/flag.
The endpoint stays behind `COMMERCE_MCP_ENABLED` (staging only).

## Tests
- `services/gateway/test/commerce-mcp.test.ts`: the EXISTING metadata test is amended (its
  `toMatchObject` gains `scopes_supported: ["email","profile"]`) and asserts `openid` is absent;
  metadata includes `scopes_supported` exactly
  `["email","profile"]` and never `openid`; 401 challenge contains `scope="email profile"` and
  still `resource_metadata="…/.well-known/oauth-protected-resource/mcp"`.
- Staging suite `docs/validation/<VTID>/staging-tests.json` (http, read-only): GET metadata body
  contains `scopes_supported` and `"email"`; unauthenticated POST /mcp is a 401 rejected probe.

## Phasing and stop rule
1. Ship this change (staging only). 2. Owner re-runs the real Claude connection once.
3. Read the Supabase auth logs (read-only). If Claude still requests `openid` (or the token
exchange still fails on ID-token signing), STOP: no further scope-hint iterations; return to the
owner with the signing-key migration path (JWKS env on both gateways, edge-function review, then
rotation) as a separate VTID. If the scope fix works, the signing-key migration is not needed now
and is only re-raised if an assistant requires `openid`.

## Verification after merge (honest limit)
Read-only checks on staging (metadata + challenge). Whether Claude honours the advertised scope is
only provable by the owner re-running the real connection; then I read the Supabase auth logs
(read-only) for the requested scope and the token status. If Claude still asks for `openid`,
stop and return to the owner with the signing-key path (no change made on my own).

## Change class / scope
- class: standard (touches an auth-adjacent route file and the OAuth challenge header)
- scope: services/gateway/src/routes/commerce-mcp.ts, services/gateway/test/commerce-mcp.test.ts,
  docs/validation/<new VTID>/** (evidence pack + staging-tests.json, cross-referencing VTID-04847)
- tracking: a NEW VTID (distinct fix, governance rule 2b), allocated only after owner approval.
<!-- plan:end -->


## Planner responses (round 1)
- F1 [minor] ACCEPTED — the existing metadata test is amended (adds `scopes_supported`, asserts no `openid`); plan updated.
- F2 [minor] ACCEPTED — `scope` goes before `error`; plan updated.
- F3 [major] ACCEPTED — explicit "Phasing and stop rule" section added: one owner retry, then stop and return to the owner with the signing-key path; no iterating on scope hints. (Note: with an intersection rule the result is {email, profile}; only a client that ignores both hints or takes the AS list would still send `openid`, which is exactly what the retry detects.)
- F4 [minor] ACCEPTED (softened) — wording now cites the Supabase OAuth 2.1 Flows guide for "ID token only when `openid` is requested" and states the fix does not rely on the default-scope claim.
- F5 [minor] ACCEPTED in part — this is a NEW VTID (distinct fix, rule 2b) with its own docs/validation dir cross-referencing VTID-04847; VTID-04847's acceptance record is a historical evidence pack for that merged PR and is left unchanged.
- Q1 — not confirmable from the code; the plan states it is only provable by the owner's retry (stop rule above).
- Q2 — count re-checked today (vitana-v1 supabase/config.toml: 32 `verify_jwt = true`). DEFERRED: the signing-key migration becomes its own VTID only if the stop rule triggers.


## Round 2 (partner)

F1–F5, Q1, Q2: closed. New findings: none. Verdict: CONVERGED — no blocker, no open major.
