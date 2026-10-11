# VTID-05043 - Gateway tenant membership check (Track S / S3, PR3)

Owner approval 2026-10-10 (Gate 1: "Yes approved"). Sparring: `plan-sparring.md` (added by PR2; plan hash
cf627c91318f5d076c7f476b69673c4ab77853f54d3a0b955c977e860706c664, sparring record 05c6a272-14e0-4634-99a1-df3a9563dad3).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: no new route. `requireTenant` and `requireAuthWithTenant` (`services/gateway/src/middleware/auth-supabase-jwt.ts`), used by 157 call sites in 44 route files, now check that a tenant taken from the token's `app_metadata.active_tenant_id` is a `user_tenants` membership of the caller (exafy_admin exempt).

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/memory/garden/entries (staging, a `requireAuthWithTenant` read route).

CURL_PROOF: staging GET with an invalid bearer answers 401 application/json (the gate still runs first). An authenticated member probe is not possible from STAGING-VERIFY (it sends only invalid credentials, rule 48); the member / non-member / exafy / 503 / log-mode paths are proven in Jest.

OASIS_PROOF: none by design — a refused request is not a state transition. Each refusal emits a structured warning `{"event":"tenant_membership_mismatch","vtid":"VTID-05043","user_id","tenant_id","route","mode"}`; a failed lookup emits `tenant_membership_check_unavailable`.

## Ordering (binding, plan §6)

Merge and publish only AFTER PR2's migrations A, B, C are applied to production and `post-apply-checks.sql`
shows drift = 0 and bad claims = 0. Promoting this before the backfill would 403 the 3 live members whose
legacy `memberships` row has no `user_tenants` row. Rollback lever: `TENANT_MEMBERSHIP_CHECK_MODE=log`
(task-def env) or revert.

## Acceptance criteria

AC-1: A token whose `active_tenant_id` is a tenant the caller belongs to (user_tenants row for user + tenant) passes `requireTenant` and `requireAuthWithTenant`; the lookup is by (user_id, tenant_id).
  TEST: services/gateway/test/middleware/auth-supabase-jwt.test.ts ("claim tenant + membership row → next()", both middlewares)

AC-2: A token whose `active_tenant_id` names a tenant the caller is not a member of is refused with 403 `{ok:false,error:'TENANT_NOT_MEMBER'}` and a structured `tenant_membership_mismatch` warning (user, tenant, route, mode).
  TEST: services/gateway/test/middleware/auth-supabase-jwt.test.ts ("claim tenant without membership → 403 TENANT_NOT_MEMBER + structured warning")

AC-3: exafy_admin passes with any claimed tenant and no lookup is made; a token without a tenant still falls back to the primary user_tenants row with no membership lookup.
  TEST: services/gateway/test/middleware/auth-supabase-jwt.test.ts ("exafy_admin ... → next(), no lookup", "no claim → primary fallback unchanged")

AC-4: A lookup that throws, times out, returns an error, or has no database client fails closed with 503 `{ok:false,error:'TENANT_CHECK_UNAVAILABLE'}`.
  TEST: services/gateway/test/middleware/auth-supabase-jwt.test.ts ("lookup throws → 503", "lookup returns an error → 503; Supabase not configured → 503")

AC-5: `TENANT_MEMBERSHIP_CHECK_MODE=log` performs the same lookup, emits the warning and calls next(); unset or any other value means `enforce` (the shipped default, per the plan).
  TEST: services/gateway/test/middleware/auth-supabase-jwt.test.ts ("log mode → non-member passes with the warning", "an unknown mode value means enforce")

AC-6: Positive results are cached 60 s per (user, tenant): two requests issue one lookup, the cache expires after 60 s; negative results are never cached.
  TEST: services/gateway/test/middleware/auth-supabase-jwt.test.ts ("positive result is cached", "the cache expires after 60 s", "negative result is not cached")

AC-7: In `requireAuthWithTenant` the membership lookup runs concurrently with the vitana_id lookup (Promise.all), adding no serial latency.
  TEST: services/gateway/test/middleware/auth-supabase-jwt.test.ts (both lookups exercised per request); code: `requireAuthWithTenant` Promise.all([resolveVitanaId, tenantLookup, membershipLookup])

AC-8: The rest of the gateway suite stays green with fixtures that model a real member (never loosened); the role, support and operator regression suites pass.
  TEST: npx jest (full gateway suite) — see pr3-commands.md
  TEST: npm run test:roles / test:support / test:operator

AC-9: Staging: the tenant-scoped read route still answers an invalid bearer with 401 JSON after deploy.
  CURL: GET https://preview-aws-gateway.vitanaland.com/api/v1/memory/garden/entries with an invalid bearer -> 401 application/json
