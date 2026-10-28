# VTID-05147 — Track S / S-M: members can no longer escalate their own tenant role or move their membership (security fix)

Owner approval 2026-10-13 (Gate 1: "Yes"). Sparring: `plan-sparring.md` (expedited, 2 rounds, converged).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: unchanged mounts. `requireTenantAdmin` (21 route files under `/api/v1/admin/tenants/:tenantId/*` and the admin routes that use it), `routes/admin-users.ts` (`/api/v1/admin/users`) and `POST /api/v1/orb/tool` now intersect the stored role with the permitted set.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/admin/tenants/00000000-0000-0000-0000-000000000000/settings (staging, unauthenticated GET → 401).

CURL_PROOF: staging GET `/alive` → 200 JSON; unauthenticated GET of a tenant-admin route → 401 `UNAUTHENTICATED` JSON (`outputs/staging-read-only-probes.txt`). The DB effect is proven by the SQL harness here and, after RUN-MIGRATION, by the read-only `post-apply-checks.sql` — never by a write on staging.

OASIS_PROOF: none — no event added or changed; refused calls never reach a handler.

## Acceptance criteria

AC-1: A member cannot UPDATE/INSERT/DELETE their own `user_tenants` row (active_role, tenant_id, is_primary) — 42501.
  TEST: supabase/tests/vtid_05147_s_m_lockdown.test.sql case (a), via scripts/ci/test-vtid-05147-s-m-lockdown.sh (precondition proves the fixture reproduces the live hole first)
  TEST: services/gateway/test/vtid-05147-s-m-membership-role-lockdown.test.ts ("reproduces the live hole, applies twice and passes the SQL assertions")

AC-2: A member cannot write `role_preferences`, `user_active_roles` or `user_permitted_roles` directly; anon cannot either.
  TEST: supabase/tests/vtid_05147_s_m_lockdown.test.sql cases (b), (n)
  TEST: migration self-check (`DO $check$`) — RAISEs and rolls back on any remaining anon/authenticated write privilege or client write policy

AC-3: `set_role_preference` works for a permitted role in an own tenant (and keeps `user_active_roles` in step), refuses an ungranted role, refuses any role (incl. community) in a foreign tenant, always allows the way back to community, and is no longer executable by anon; exafy admins are unchanged.
  TEST: supabase/tests/vtid_05147_s_m_lockdown.test.sql cases (c), (d), (e), (f), (i), (n)

AC-4: The other definer writers and the gateway are unaffected: `me_set_active_role`, `switch_to_tenant_by_slug` (switch, open-signup join, closed tenant refused) and `service_role` writes still work; members still read their own rows.
  TEST: supabase/tests/vtid_05147_s_m_lockdown.test.sql cases (g), (h), (j), (k), (l), (m)

AC-5: The migration is idempotent and safe on hot tables (one transaction, lock_timeout 5s, self-check), and no later migration may grant member writes back, recreate a dropped policy or redefine `set_role_preference` without the membership check.
  TEST: services/gateway/test/vtid-05147-s-m-membership-role-lockdown.test.ts (pins + guard), harness applies the file twice
  TEST: vitana-v1 src/integrations/supabase/role-tables-no-client-writes.vtid-05147.test.ts (mirror guard for that repo's migrations)

AC-6: `requireTenantAdmin` admits a non-exafy caller only when `active_role='admin'` AND 'admin' is a permitted role (user_permitted_roles or an active memberships admin); a permitted-role read error is 403; exafy unchanged. admin-users' inline check matches.
  TEST: services/gateway/test/middleware/require-tenant-admin.test.ts (VTID-05147 cases; contract changed on purpose)
  TEST: services/gateway/test/vtid-05147-effective-role-permitted.test.ts ("admin-users: …")
  CURL: staging unauthenticated GET /api/v1/admin/tenants/<id>/settings → 401 UNAUTHENTICATED application/json

AC-7: `resolveEffectiveRole` clamps a non-exafy role outside the permitted set (or an unreadable set) to 'community'; a forged developer preference on POST /api/v1/orb/tool gets `developer_role_required` from dev_list_vtids; exafy callers keep their role.
  TEST: services/gateway/test/vtid-05147-effective-role-permitted.test.ts
  TEST: services/gateway/test/routes/orb-live.test.ts (resolveEffectiveRole cases; contract changed on purpose)
  CURL: staging POST /api/v1/orb/tool with an invalid bearer → 401 application/json (rejected probe, staging-tests.json)

AC-8: Maxina unchanged: a community member resolves to community, a permitted professional to professional; the role-switch RPC path, roles/support/operator suites stay green.
  TEST: services/gateway/test/vtid-05147-effective-role-permitted.test.ts ("Maxina unchanged")
  TEST: npm run test:roles / test:support / test:operator (outputs/local-checks.txt)
  TEST: vitana-v1 src/hooks/useRoleSwitch.vtid-05147.wiring.test.ts

AC-9: Pre/post-apply checks are read-only and the rollback restores the 2026-10-13 state (and the migration re-applies after it).
  TEST: outputs/local-pre-post-rollback.txt (local cluster: pre-apply ran, post-apply matrix, rollback re-opens, re-apply OK)
  TEST: services/gateway/test/vtid-05147-s-m-membership-role-lockdown.test.ts ("the evidence pack carries pre/post-apply checks and the rollback")
