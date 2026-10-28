# VTID-05149 - Multi-tenant M0 lane A: tenant foundation

Owner approval 2026-10-13 (Gate 1: "Yes"). Sparring: `plan-sparring.md` (converged, 2 rounds, record e1cd7275-b9f6-49a8-b5b6-e026c4b97fb7).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: no new route. `requireTenant` / `requireAuthWithTenant` (every tenant-scoped route) resolve the primary tenant through `services/tenancy/tenant-context.ts` and set `req.tenant`; `GET /api/v1/auth/me` auto-provision uses the default tenant.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/auth/health (staging).

CURL_PROOF: read-only probes in `staging-tests.json` (auth health 200 JSON; `/auth/me`, `/autopilot/prefs`, `/memory/garden/entries` without a token 401 JSON; build-info).

OASIS_PROOF: no OASIS events added or changed.

DB: three migrations, applied in the order of `docs/multitenancy/MIGRATION-QUEUE.md` after Gate 2 (never applied by this PR). Live md5s re-verified read-only 2026-10-13 before building M2: `handle_new_user()` 9599cfbfa7d9f8532ea1564df99e430f, `provision_platform_user()` 6254e35b2765d8edd5976ec5b9eec4f3 (unchanged from the plan).

## Acceptance criteria

AC-1: `tenants.is_default` / `tenants.is_platform` exist; exactly one default (maxina) is enforced: a second default is a unique violation, zero defaults fail at COMMIT, a swap inside one transaction works, `is_default AND is_platform` is a CHECK violation, and the deferred trigger fires for an `authenticated` UPDATE although EXECUTE is revoked. M1 commits on the 2-row table and refuses a re-apply.
  TEST: scripts/ci/sql-tests/run-tenant-foundation-test.sh (cases 1, 4, 7, 8) via .github/workflows/SQL-TENANT-FOUNDATION.yml
  TEST: services/gateway/test/vtid-05149-tenant-foundation-migrations.test.ts (M1 statement order, deferred trigger, revoke)

AC-2: For the same signups (no slug, maxina, alkalma, unknown slug) the live trigger bodies and M1+M2 write identical rows in profiles, global_community_profiles, memberships, role_preferences, app_users, user_tenants, user_permitted_roles and app_metadata, and fire the four side-effect triggers in the same order (4 per signup).
  TEST: scripts/ci/sql-tests/run-tenant-foundation-test.sh (case 1, golden diff)
  TEST: services/gateway/test/vtid-05149-tenant-foundation-migrations.test.ts (M2 body diff limited to the slug filter, default lookup and warning)

AC-3: A signup without a usable slug lands in the `is_default` tenant even when alkalma is physically first (the created_at tie no longer decides); slugs of a closed, a platform and an inactive tenant land in the default tenant; with no default at all the signup still succeeds, raises a WARNING and creates no membership.
  TEST: scripts/ci/sql-tests/run-tenant-foundation-test.sh (cases 2, 3, 5)

AC-4: M2 refuses to apply when either live function drifted from the captured md5 (nothing clobbered) or before M1; R3 → R2 → R1 restores the before-state exactly (md5s, columns, constraints, ACLs); R1 refuses to run before R2.
  TEST: scripts/ci/sql-tests/run-tenant-foundation-test.sh (cases 7, 8)
  TEST: services/gateway/test/vtid-05149-tenant-foundation-migrations.test.ts (md5 guards, functions-before.sql reproduces the live md5s, R2 = captured bodies)

AC-5: `ci_tenant_isolation_health()` returns every key with exact counts on a fixture (foreign/NULL rows, top tables, 0/2+ primaries, auth users without membership, memberships drift, default/platform counts), never row content; a table that cannot be scanned is listed in `scan_errors` while the rest is counted; anon/authenticated are denied, service_role allowed.
  TEST: scripts/ci/sql-tests/run-tenant-foundation-test.sh (case 6)
  TEST: services/gateway/test/vtid-05149-tenant-foundation-migrations.test.ts (grants, aggregate-only scan, keys)

AC-6: One deterministic primary-tenant resolver (`is_primary desc, created_at, tenant_id`, limit 1) with a tagged result (`found` / `none` / `unavailable`); a non-primary hit is `membership_fallback` and logged; two primary rows no longer give 400.
  TEST: services/gateway/test/vtid-05149-tenant-context.test.ts (resolvePrimaryTenant, two primary rows)
  TEST: services/gateway/test/middleware/auth-supabase-jwt.test.ts (query shape updated: order/limit instead of eq('is_primary', true).single())

AC-7: `requireTenant` / `requireAuthWithTenant` set `req.tenant = {tenantId, slug, role, source, isPlatform}` (`token`, `exafy_admin_token`, `primary`, `membership_fallback`; Cognito identities resolve `primary`), keep `req.identity.tenant_id` exactly as before, never fail a request when tenant metadata is unavailable, and keep the VTID-05043 403/503/log-mode behaviour; `getTenantContext(req)` resolves lazily for `requireAuth` routes and memoises.
  TEST: services/gateway/test/vtid-05149-tenant-context.test.ts (middleware, Cognito, getTenantContext)
  TEST: services/gateway/test/middleware/auth-supabase-jwt.test.ts (VTID-05043 cases unchanged, 54 tests)
  CURL: staging GET /api/v1/memory/garden/entries without a token -> 401 application/json

AC-8: `/auth/me` auto-provision upserts the membership into the `is_default` tenant (alkalma first with the same created_at does not matter); with no default it creates no membership and logs `default_tenant_unresolved`; no code orders `tenants` by `created_at` and `fetchOldestTenant` is gone; universal-cart `resolvePrimaryTenantId` delegates to the resolver.
  TEST: services/gateway/test/vtid-05149-tenant-context.test.ts (/auth/me auto-provision, source pin, universal-cart)
  CURL: staging GET /api/v1/auth/me without a token -> 401 application/json

AC-9: Morning row 21b reports the RPC as INFO only (counts, top tables, primaries, drift, default); 404 and malformed replies are INFO too; it never writes FAIL and TOTAL_CHECKS stays 22.
  TEST: services/gateway/test/vtid-05149-tenant-context.test.ts (morning row 21b, the step's own bash on fixture replies)
  TEST: services/gateway/test/vtid-04345-morning-memory-check.test.ts (row 22 stays last, TOTAL_CHECKS 22)

AC-10: After the apply window: post-checks pass (`post-apply-checks.sql`) and, 24 h later, every new auth.users row has exactly one primary user_tenants row and a memberships row in the same tenant.
  TEST: docs/validation/VTID-05149/post-apply-checks.sql (read-only; results recorded here after apply)
