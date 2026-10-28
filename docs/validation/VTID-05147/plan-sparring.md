# VTID-05147 — Plan Sparring record (Track S / S-M, members can escalate their own tenant role and membership)

Change class: expedited (Track S security hotfix, live exposure). Sparring record
`cc98a8e9-2d86-4286-a19e-5e828e66163a` (`plan_sparring_sessions`), 2 rounds, verdict **CONVERGED**.
`VTID-XXXXX` in the plan text is VTID-05147 (allocated after approval; the plan was hashed before the
substitution, so the placeholders are kept verbatim below).

**Implementation note:** the plan's migration version `20261013200000` was already taken on origin/main
(`20261013200000_vtid_05143_unified_card_system.sql`); the migration ships as
`supabase/migrations/20261013233000_vtid_05147_s_m_membership_role_lockdown.sql` (still sorts after every
existing file and before lane A's `20261014000100`). Orchestrator decision, plan text unchanged.

# Track S / S-M — members can escalate their own tenant role and membership
change class: expedited (Track S security hotfix, live exposure)
scope:
- platform: new `supabase/migrations/20261013200000_vtid_05147_s_m_membership_role_lockdown.sql`;
  new `docs/validation/VTID-05147/{plan-sparring.md,staging-tests.json,pre-apply-checks.sql,post-apply-checks.sql,rollback-s-m.sql}`;
  new `supabase/tests/vtid_05147_fixture.sql`, `supabase/tests/vtid_05147_s_m_lockdown.test.sql`, `scripts/ci/test-vtid-XXXXX-s-m-lockdown.sh`;
  new `services/gateway/test/vtid-XXXXX-s-m-membership-role-lockdown.test.ts`;
  gateway defence in depth: new `services/gateway/src/lib/permitted-roles.ts`; touch `services/jev/jev-caller.ts` (re-export only),
  `middleware/require-tenant-admin.ts` (+ `-repository.ts`), `routes/admin-users.ts` (tenant-admin check),
  `routes/orb-live.ts` (`resolveEffectiveRole` + its 1 in-file caller), `routes/orb-tool.ts`, `orb/live/session/live-session-controller.ts` (deps signature + 1 call);
  tests `test/middleware/require-tenant-admin.test.ts` (updated on purpose), new `test/vtid-XXXXX-effective-role-permitted.test.ts`.
- v1: new `src/integrations/supabase/role-tables-no-client-writes.vtid-XXXXX.test.ts` (static guard + mirror guard), new `src/hooks/useRoleSwitch.vtid-XXXXX.wiring.test.ts`. No runtime v1 change.
Evidence base: origin/main @ e1ad8a0fd (platform), d09d66c4f (v1); live read-only checks 2026-10-13 (Supabase `inmkhvwdcuyhnxkgfvsb`).
<!-- plan:begin -->

## Problem

Live state, read-only queries on 2026-10-13: `pg_policies`, `information_schema.role_table_grants`, `pg_trigger`, `pg_get_functiondef`.

1. **`user_tenants`: members can rewrite their own membership row.**
   - The policy `user_tenants_update_own` is `FOR UPDATE TO authenticated USING (user_id = auth.uid())` with no WITH CHECK. It was created in `supabase/migrations/20251231000000_vtid_01101_phase_a_bootstrap.sql:115-116`.
   - `authenticated` holds INSERT/SELECT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER. `anon` holds SELECT/TRUNCATE/REFERENCES/TRIGGER.
   - There is no UPDATE trigger; the only triggers are the 4 AFTER INSERT primary-membership triggers.
   - So a member can PATCH `/rest/v1/user_tenants?user_id=eq.<self>` and set any of:
     - `active_role='admin'`;
     - `tenant_id=<any tenant>`. The unique `(tenant_id,user_id)` is the only limit, so this moves the membership;
     - `is_primary`.
2. **What a forged `active_role='admin'` unlocks.**
   - `requireTenantAdmin` (`middleware/require-tenant-admin.ts:55`) admits a caller when `user_tenants.active_role === 'admin'` (`:120-133`, repo `require-tenant-admin-repository.ts:21`). Step 4 only requires the target tenant to be the JWT tenant (`:104`), and that comes from `app_metadata.active_tenant_id` (`auth-supabase-jwt.ts:273`).
   - This gate is used by 21 route files: all of `routes/tenant-admin/*` (invitations, settings, content-moderation, audit-log, community-admin, kpis, …), `admin-notification-controls`, `admin-marketplace`, `admin-community-marketplace`, `admin-autopilot`, `product-analytics`, `admin-staging`, `vcaop-portal-my-products`.
   - `routes/admin-users.ts:79-87` makes the same check inline.
   - A member therefore becomes full tenant admin of their own tenant (Maxina today).
   - With the `tenant_id` rewrite, `switch_to_tenant_by_slug` then sees `v_is_member` (live body) and points `active_tenant_id` at the new tenant. That makes the member admin of **any** tenant, including closed ones. It also defeats the S-E gateway membership check, because the membership row itself is forged.
3. **`role_preferences`: the role value is unconstrained.**
   - The policies `rp_upsert_self`, `rp_update_self` and `rp_delete_self` check only `auth.uid() = user_id`. Neither `role` nor `tenant_id` is checked.
   - Since VTID-04318/04561 the gateway treats this table as the effective role: `pickEffectiveRole` (`services/orchestrator/active-role.ts:21-29`) lets the preference win.
   - **Live impact:**
     - `POST /api/v1/orb/tool` (`routes/orb-tool.ts:57`, `requireAuth` only, mounted `index.ts:965`) resolves `role = resolveEffectiveRole(...)` (`:71-80`, `routes/orb-live.ts:813-826`).
     - A member who writes `role='developer'` or `'admin'` passes `developerGate` (`services/orb-tools/developer-tools.ts:35-47`).
     - The developer voice tools then run with the service-role client. Examples: the `dev_*` ledger/OASIS reads in `developer-tools.ts`, and `cicd-pr-tools.ts`, `database-migrations-tools.ts`, `autopilot-controller-tools.ts`, all gated only by `developerGate`.
   - **Already clamped (no further action):**
     - Jev intersects with the permitted set and returns 403 `effective_role_not_permitted` (`services/jev/jev-caller.ts:105-134`).
     - Community-autopilot `lineup-role.ts` clamps.
     - VTID-04560 limits the live ORB persona: `clampRoleToProfile` (`orb/profile/assistant-profile.ts:160-167`) serves only member-plane roles on member screens and serves work surfaces from their fixed role. So `role_preferences` cannot change which Vitana assists.
     - Live-session tool identity uses the JWT role, not the preference (`routes/orb-live.ts` dispatch sites).
     - `automation-executor-repository.ts:59` only uses the effective role for targeting.
4. **`user_active_roles`: same hole.**
   - The policies `user_active_roles_insert` and `user_active_roles_update` check only `user_id = auth.uid()`, with no role check (`20251229000000_vtid_01051_me_active_role_fix.sql:124-130`).
   - `me_context()` (SECURITY DEFINER) returns `active_role` from this table.
   - `routes/command-hub.ts:21,27-62` `requireDeveloperAccess` admits `developer|admin|infra|staff` from `me_context` to `POST /command-hub/api/chat` (`:89`).
   - `lib/tenant-role-auth.ts:49-58,89` reads it too. That gate is saved today only because `me_context.tenant_id` (`current_tenant_id()`, JWT top-level claim) is null.
5. **The sanctioned writers validate; the v1 client never writes these tables directly.**
   - SECURITY DEFINER writers, found by a regex over `prosrc` for INSERT/UPDATE/DELETE on the 4 tables:
     - `set_role_preference` (non-exafy: role must be in `check_role_permitted` or an active `memberships` role, never `admin`; **but `'community'` is accepted for any `p_tenant_id`, member or not**; EXECUTE granted to PUBLIC and anon);
     - `me_set_active_role` (permitted check; writes `role_preferences` only for a `user_tenants` tenant);
     - `switch_to_tenant_by_slug` (S-E body);
     - `provision_platform_user` and `handle_new_user` (auth.users triggers).
   - v1 switches roles only through `supabase.rpc('set_role_preference')` (`src/hooks/useRole.tsx:67`, called from `useRoleSwitch.ts:92`).
   - Correction to the brief: `useRoleSwitch.ts` does not write the table directly.
   - `git grep` finds no v1 `src/` or `supabase/functions` insert/update/upsert/delete on `user_tenants`, `role_preferences`, `user_active_roles` or `user_permitted_roles`. `request-account-deletion` uses its service client.
   - The gateway writes `user_tenants` and `user_permitted_roles` only with `getSupabase()`, which is service role (`lib/supabase.ts:5-9`):
     - `routes/auth-repository.ts:68`;
     - `services/admin-signups/admin-signups-repository.ts:117`;
     - `services/tenant-invitations/tenant-invitations-repository.ts:103,107`.
6. **Same-class checks.**
   - `user_permitted_roles`: anon and authenticated hold INSERT/UPDATE/DELETE grants, but the only policies are SELECT-own (authenticated) and ALL (service_role). RLS already blocks writes, so this is hygiene.
   - `memberships`: writes are gated by `is_exafy_admin(auth.uid())`, which is fine. It still has the TRUNCATE/TRIGGER/REFERENCES grants (hygiene).
   - `app_users_owner_write`: `USING/WITH CHECK (tenant_id = current_tenant_id() AND user_id = auth.uid())`.
     - Today it is **inert**: `current_tenant_id()` reads `request.tenant_id`, which only service-role `dev_bootstrap_request_context` sets, or a top-level JWT `tenant_id` that no token carries (no access-token hook exists, checked live).
     - It becomes live the moment WS1's hook emits `tenant_id`. Members could then set `stripe_charges_enabled`, `stripe_account_id`, `status`, `lifecycle_stage` and `welcome_chat_sent` themselves. **Deferred with a hard precondition** (see Out of scope).
   - PostgREST cannot issue TRUNCATE, so anon/authenticated TRUNCATE is hygiene.
7. **Data, 2026-10-13. No evidence of exploitation.**
   - `user_tenants`: 241 rows (maxina 237, alkalma 4), every `active_role` `community` except 1 `developer` (exafy). 0 `admin`.
   - The 3 rows without a matching `user_permitted_roles` row all belong to exafy admins.
   - Only 1 row was updated more than 1 minute after creation: exafy, 2026-02-18.
   - `role_preferences`:
     - 220 community rows of members that are permitted;
     - admin 1 and developer 1, both exafy;
     - 12 community rows whose tenant has no `user_tenants` row (maxina 11, alkalma 1). All 12 belong to **deleted** auth users and are inert.
   - `user_active_roles`: 4 rows, all community.
   - `memberships`-only active rows: 0.
   - `auth.users`: 238. Users whose `active_tenant_id` claim is not a `user_tenants` membership: 0. Users with no membership: 0.
   - Legitimate admin grants: `user_permitted_roles` admin 5, `memberships` admin 4.

## Fix

**Shape.** Remove every client write path to the role and membership tables. The sanctioned SECURITY DEFINER RPCs already validate, so no new trigger is needed: the v1 role switch already goes through `set_role_preference`. A `role_preferences` trigger was evaluated and rejected. It would also fire inside the definer RPCs and inside `handle_new_user` at signup, where `auth.uid()` is NULL, so it would need `current_user` special-casing for no gain once direct writes are revoked.

**A. DB: one migration, one transaction, self-checking.**
1. `user_tenants`:
   - `DROP POLICY IF EXISTS user_tenants_update_own`;
   - `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON public.user_tenants FROM anon, authenticated`.
   - SELECT and the two SELECT policies stay.
2. `role_preferences`:
   - `DROP POLICY IF EXISTS rp_upsert_self, rp_update_self, rp_delete_self`, as three statements;
   - the same REVOKE.
   - `rp_select_self` and SELECT stay; `useRole` reads it.
3. `user_active_roles`:
   - `DROP POLICY IF EXISTS user_active_roles_insert, user_active_roles_update`;
   - the same REVOKE.
   - `user_active_roles_select` stays.
4. Hygiene:
   - `user_permitted_roles`: the same REVOKE from anon and authenticated (no policy allowed those writes anyway).
   - `memberships` and `app_users`: `REVOKE TRUNCATE, TRIGGER, REFERENCES … FROM anon, authenticated` only. Their write policies are untouched.
5. `set_role_preference(uuid,text)`: `CREATE OR REPLACE` with the live body, verbatim from `pg_get_functiondef` on 2026-10-13, last defined in `20260925120000_vtid_04561_one_role_truth.sql`. Two additions at the top:
   ```sql
   IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
   -- after is_exafy_admin is computed:
   IF NOT is_exafy_admin AND NOT EXISTS (SELECT 1 FROM public.user_tenants ut
        WHERE ut.user_id = auth.uid() AND ut.tenant_id = p_tenant_id) THEN
     RAISE EXCEPTION 'Not a member of this tenant' USING ERRCODE = '42501';
   END IF;
   ```
   Then:
   ```sql
   REVOKE EXECUTE ON FUNCTION public.set_role_preference(uuid,text) FROM PUBLIC, anon;
   GRANT EXECUTE ON FUNCTION public.set_role_preference(uuid,text) TO authenticated, service_role;
   ```
   This satisfies the VTID-05041 guard.
   - **Community rule:** `'community'` stays always allowed, but only in a tenant the caller belongs to (or for an exafy admin). This is safe today: 0 users have a claim outside their memberships.
   - The existing non-exafy `admin` refusal is unchanged.
6. `me_set_active_role`, `switch_to_tenant_by_slug` (which itself inserts into `role_preferences` at `20261010180200_vtid_05043_…:86-88`), `provision_platform_user` and `handle_new_user` are **unchanged**. They are definer functions run as owner, so the revokes do not affect them.
7. Self-check `DO` block at the end. It RAISEs on any failure, which rolls back the whole migration and turns RUN-MIGRATION red. It asserts:
   - `has_table_privilege('authenticated'|'anon', t, 'INSERT'|'UPDATE'|'DELETE'|'TRUNCATE')` is false for the 4 tables;
   - SELECT is true for authenticated;
   - `service_role` still has INSERT/UPDATE/DELETE on all 4;
   - no `pg_policies` row on the 4 tables with `cmd IN ('INSERT','UPDATE','DELETE','ALL')` outside `{service_role}`;
   - `has_function_privilege('anon', 'public.set_role_preference(uuid,text)', 'EXECUTE')` is false;
   - authenticated still has EXECUTE on `set_role_preference`, `me_set_active_role` and `switch_to_tenant_by_slug`.

**B. v1: guards only, no runtime change.**
- A static vitest fails if `src/` or `supabase/functions/` adds `.from('user_tenants'|'role_preferences'|'user_active_roles'|'user_permitted_roles')` followed by `.insert|.update|.upsert|.delete` outside files that build a service-role client.
- A mirror guard, in the VTID-05043 style, fails if a v1 migration recreates one of the dropped policies, or creates or replaces `set_role_preference` without the membership check.

**C. Gateway defence in depth: wherever an effective or tenant role decides authorization, intersect it with the permitted set.**
1. New `lib/permitted-roles.ts`:
   - `fetchPermittedRoles(sb, userId, tenantId): Promise<{roles: string[] | null; error?: string}>`. It runs `user_permitted_roles` and active `memberships` in parallel through the service client and returns `computePermittedRoles`, which moves here from `jev-caller.ts:55-59`. `jev-caller.ts` re-exports it, so the Jev tests are unchanged.
   - A read error returns `roles:null`, and callers fail closed.
2. `requireTenantAdmin` step 5 (`:120`): also require `'admin' ∈ fetchPermittedRoles(...)`. Otherwise 403 FORBIDDEN, with the same body and the log reason `admin_not_permitted`. `routes/admin-users.ts:86` gets the same check. exafy_admin still bypasses at `:91`.
3. `resolveEffectiveRole(userId, tenantId, opts?: { exafyAdmin?: boolean })` (`routes/orb-live.ts:813`):
   - A third parallel read is `fetchPermittedRoles`.
   - If not exafy and the picked role is not in the permitted set, return `'community'` and log `[VTID-05147] effective role clamped`.
   - If the permitted read fails, return `'community'`.
   - Exafy callers are unchanged. This matters because the owner's `developer` and `admin` preferences have no permitted rows.
   - Callers pass the flag as a call argument, read from `req.identity.exafy_admin` (or the ORB session's `bootstrapIdentity.exafy_admin`). `OrbToolIdentity` is unchanged: `developerGate` (`developer-tools.ts:38-47`) reads `id.role`, which is already the clamped value.
   - Callers pass the flag:
     - `routes/orb-tool.ts:75`: `req.identity.exafy_admin`;
     - `live-session-controller.ts:184` (deps type) and `:1520`: `bootstrapIdentity.exafy_admin`;
     - `routes/orb-live.ts:18320`: `identity.exafy_admin`.
   - The extra read runs in parallel, so there is no added round trip.
4. Not changed:
   - `command-hub.ts requireDeveloperAccess` and `tenant-role-auth.ts`. They read `user_active_roles` through `me_context`, which A3 closes to definer writers that already validate.
   - Jev, which already intersects.

## Migrations

- **File:** `supabase/migrations/20261013200000_vtid_05147_s_m_membership_role_lockdown.sql`.
- **Header:**
  - `SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '60s';`.
  - `DROP POLICY` and `REVOKE` take a brief exclusive lock on hot-read tables. The 5 s limit prevents a lock queue; on a timeout the migration fails red and is re-run.
  - Idempotent: `IF EXISTS` and repeatable REVOKE/GRANT.
- **Class:** a contract-only change. No expand step is needed, because no client uses the removed paths (Problem 5).
- **Pre-apply** (read-only, `docs/validation/VTID-05147/pre-apply-checks.sql`): re-run the Problem 7 counts. **STOP conditions:** any `user_tenants.active_role` outside `{community}` held by a non-exafy user without a permitted row; any user whose `active_tenant_id` is not a membership; any non-exafy `role_preferences` row with a role outside the permitted set; any non-exafy `user_active_roles` row whose `active_role` is outside `{community}` and not in that user's permitted set (`me_context` would keep serving such a poisoned row after the revoke). Expected: none (live 2026-10-13: 4 rows, all community). The same STOP conditions are re-run read-only immediately AFTER apply, closing the window between the pre-check and the revoke. A violator is an exploitation signal: stop, investigate the audit trail, and correct it with a separate owner-approved service-role data fix. Never fold that into this migration.
- **Post-apply** (read-only, `post-apply-checks.sql`): `has_table_privilege` matrix, `pg_policies` on the 4 tables, `has_function_privilege` for `set_role_preference` (anon false, authenticated true), and the Problem 7 counts unchanged.
- **Rollback** (`docs/validation/VTID-05147/rollback-s-m.sql`): recreate the 6 policies exactly as they are live, re-GRANT the revoked privileges, and restore the 2026-10-13 `set_role_preference` body and ACL. It re-opens the hole, so it is for emergency use only and needs owner approval.
- **No new SECURITY DEFINER function.** `set_role_preference` is replaced in place, and its PUBLIC and anon EXECUTE is revoked in the same file.

## Tests

1. **SQL harness** (`scripts/ci/test-vtid-XXXXX-s-m-lockdown.sh`, which copies `test-vtid-05041-definer-lockdown.sh`; throwaway `initdb` cluster).
   - The fixture recreates, from live definitions, the roles anon/authenticated/service_role, `auth.uid()`/`auth.jwt()` over `request.jwt.claims`, the 6 tables with their live grants and policies, `check_role_permitted`, `me_context`, `me_set_active_role`, `set_role_preference` and `switch_to_tenant_by_slug`, plus a stub `membership_side_effects_suppressed()`.
   - Tenants are T_A (open_signup) and T_B (closed). Users: member M (T_A, community, permitted `professional`), exafy X, and deleted-user orphan rows.
   - **Pre-migration** (proves the fixture reproduces the hole): as M, `UPDATE user_tenants SET active_role='admin'` succeeds, `INSERT role_preferences(role='developer')` succeeds, and `INSERT user_active_roles('developer')` succeeds.
   - **Post-migration, member M:**
     - (a) cannot UPDATE own `active_role`, `tenant_id` or `is_primary` (42501);
     - (b) cannot INSERT, UPDATE or DELETE `role_preferences` or `user_active_roles` directly;
     - (c) `set_role_preference(T_A,'professional')` succeeds, and the row and `user_active_roles` both read `professional`;
     - (d) `set_role_preference(T_A,'developer')` raises "Role not granted";
     - (e) `set_role_preference(T_B,'community')` raises "Not a member";
     - (f) `set_role_preference(T_A,'community')` succeeds, so the way back always works;
     - (g) `me_set_active_role('community')` succeeds;
     - (h) M can still SELECT own `user_tenants`, `role_preferences` and `user_active_roles`.
   - **Post-migration, exafy and service role:**
     - (i) exafy X: `set_role_preference(T_B,'developer')` succeeds;
     - (j) `service_role` can UPDATE `user_tenants.active_role` and INSERT `role_preferences`.
   - **Post-migration, `switch_to_tenant_by_slug`:**
     - (k) a member switching to T_A succeeds;
     - (l) a new user joining T_A gets a `user_tenants` row;
     - (m) T_B raises `TENANT_NOT_JOINABLE`.
   - **Post-migration, anon and repeatability:**
     - (n) anon cannot EXECUTE `set_role_preference`;
     - (o) a second apply is a no-op and the self-check passes.
2. **Jest** `test/vtid-XXXXX-s-m-membership-role-lockdown.test.ts`:
   - pins the migration statements, the self-check, `lock_timeout`, and the REVOKE on `set_role_preference`;
   - **guard:** any later migration that GRANTs INSERT/UPDATE/DELETE/ALL on the 4 tables to anon/authenticated/PUBLIC, recreates a dropped policy name, or redefines `set_role_preference` without the membership check fails the build;
   - runs the SQL harness when a local Postgres is available, the same way the VTID-05041 suite does.
3. **Jest DiD:**
   - `require-tenant-admin.test.ts` (updated on purpose, stated in the PR):
     - `active_role='admin'` without a permitted admin role returns 403;
     - a `user_permitted_roles` admin passes;
     - an active `memberships` admin passes;
     - a permitted-read error returns 403;
     - exafy passes unchanged.
   - New `vtid-XXXXX-effective-role-permitted.test.ts`:
     - a `developer` preference that is not permitted resolves to `community`;
     - a permitted one resolves to `developer`;
     - an exafy caller keeps `developer` with no permitted rows;
     - a read error resolves to `community`;
     - through the `/orb/tool` route with a mocked forged preference, `dev_list_vtids` returns `developer_role_required`.
   - The admin-users inline check gets one case.
4. **v1 vitest:**
   - `role-tables-no-client-writes.vtid-XXXXX.test.ts` (static plus mirror guard).
   - `useRoleSwitch.vtid-XXXXX.wiring.test.ts`, which renders the hook with a mocked supabase:
     - switching to a permitted `professional` calls only `rpc('set_role_preference', {p_tenant_id, p_role:'professional'})` and navigates;
     - an RPC error (as the new "Not a member" / "Role not granted" raise) rolls back, calls `notifyError` and does not navigate;
     - no `.from('role_preferences').upsert` exists.
   - The existing `useRole.setRole.test.ts` and `useRoleSwitch.test.ts` stay green.
5. **Suites that must stay green:**
   - `npm run test:roles` (role separation: profile clamp and greeting unchanged; `resolveEffectiveRole` signature extended with an optional argument);
   - `npm run test:operator` (unaffected, run because `orb-live.ts` changes);
   - `test/orb/live/session/live-session-controller.test.ts`, `vtid-04545-session-start-characterization`, `vtid-04548-prewarm-brain-role`, `test/vtid-05041-definer-lockdown.test.ts`, `vtid-05043-s3-migrations.test.ts` and the Jev tests;
   - gateway `tsc` and lint; v1 `npm test`.
6. **Maxina unchanged:**
   - harness case (c), (f) and (k);
   - jest: a community member's effective role is still `community`, and a permitted professional's is still `professional`.

## Staging verification

Read-only only: staging writes to production Supabase, so nothing here attempts a write, not even a refused PATCH.

`docs/validation/VTID-05147/staging-tests.json` (gateway) contains:
- `GET /alive`;
- unauthenticated `POST /api/v1/orb/tool` → 401;
- unauthenticated `GET /api/v1/admin/tenants/x/members`-class tenant-admin route → 401 `UNAUTHENTICATED`;
- `existing` refs: the two new jest files and `require-tenant-admin.test.ts`.

The DB effect is proven by the read-only `post-apply-checks.sql` after RUN-MIGRATION, not by staging HTTP.

## Rollout

1. **One PR per repo.**
   - Platform: migration, harness, gateway DiD and tests.
   - v1: tests only, so it deploys nothing and has no Gate 2.
2. **Expedited sparring.** At least 2 passes, then owner Gate 1, then the VTID.
3. **Merge order: the platform PR first.** Then:
   - **Migration:**
     - Run the read-only pre-apply checks.
     - Owner-approved `RUN-MIGRATION.yml` (`migration_file=supabase/migrations/20261013200000_…`) in the next window, as soon as possible because this is a live exposure.
     - Run the post-apply checks.
     - Add the migration to the Track S apply packet.
   - **Gateway:** staging deploy → STAGING-VERIFY → Gate 2 → prod pinned to the verified commit, diffed against prod build-info.
   - The gateway DiD is independent of the migration and is safe in either order.
4. **No flags.**

## Risks

- **Lock on hot tables.** `user_tenants` is read on most requests. The 5 s `lock_timeout` plus a re-run bounds the impact; apply off-peak.
- **A hidden client writer was missed.** The repo grep covers v1 `src/` and `supabase/functions` and the gateway. Command Hub `app.js` writes go through gateway routes. Native apps or other clients outside both repos would now get 42501.
  - Mitigation: watch PostgREST 4xx on these tables in Supabase logs for 24 h after apply.
  - The rollback exists but re-opens the hole.
- **New membership check in `set_role_preference`.** It could refuse a legitimate switch if a client passes a tenant the user does not belong to. 0 such users today; the v1 toast and rollback path is covered by the wiring test.
- **DiD fail-closed reads.** These could downgrade a legitimate tenant admin or developer during a Supabase read error (they fall to `community`, or get 403 on admin routes). This is intended fail-closed behaviour. Exafy is unaffected.
- **Dual members.** A member of two tenants calling `set_role_preference` for the non-active tenant also overwrites `user_active_roles` (global, no tenant column). 0 dual members today; resolved by WS1's single role source of truth.
- **Stale grants.** If Supabase default privileges or a future "grant all" migration re-adds writes, the jest guard and the self-check catch it in CI and at apply time.

## Out of scope

- **`app_users_owner_write` column-level lockdown** (`REVOKE UPDATE`, then `GRANT UPDATE (display_name, updated_at)`):
  - it is inert today (Problem 6);
  - it is a **hard precondition of the WS1 access-token-hook slice**: it must ship before the hook emits a top-level `tenant_id`;
  - recorded in the WS1 plan.
- **Unifying the role sources** (`role_preferences` / `user_active_roles` / `user_tenants.active_role` / `user_permitted_roles` / `memberships.role` → one): WS1 "single role source of truth".
- **Header and query-hint roles** (`X-Vitana-Active-Role` in `calendar.ts:168`, `memory-garden.ts:48`; `cors.ts:67`) and **client-declared ORB `surface`** (`assistant-profile.ts:106-128`, `unverified` resolution): a separate Track S follow-up slice to verify whether any of them authorizes anything.
- **`set_role_preference` refusing `admin` for permitted tenant admins** while `me_set_active_role` allows it: existing behaviour, WS1.
- **The 12 orphan `role_preferences` rows of deleted users:** FU8 / account-deletion cleanup.
- Revoking anon SELECT on these tables (RLS already returns nothing): WS0 grants lint.

## Owner decisions

None. The program register settles Track S as expedited hotfixes. The conservative choices are recorded in this plan: revoke rather than add a trigger, community allowed only within the caller's own memberships, and fail-closed DiD.
<!-- plan:end -->

## Planner responses — round 1
- F1 (blocker) — ACCEPTED. S-M's migration is `20261013200000_vtid_05147_s_m_membership_role_lockdown.sql`, sorting before every lane (A 20261014000100–000300, B 000400–000500, C 000600–000700); S-M merges and is applied first; recorded in `docs/multitenancy/MIGRATION-QUEUE.md`.
- F2 (major) — ACCEPTED. Gateway item 3 now states the flag is a call argument from `req.identity.exafy_admin` / `bootstrapIdentity.exafy_admin`; `OrbToolIdentity` is unchanged because `developerGate` reads the already-clamped `id.role`.
- F3 (major) — ACCEPTED. Pre-apply STOP conditions now include `user_active_roles` (non-exafy rows outside `{community}` and not permitted), and the STOP queries are re-run immediately after apply to close the pre-check→revoke window. A violator follows the existing exploitation protocol (stop, investigate, separate owner-approved data fix).
- F4 (minor) — ACCEPTED. Fix 6 names `switch_to_tenant_by_slug`'s own `role_preferences` insert (VTID-05043:86-88) as unaffected (definer, runs as owner).
- F5 (minor) — ACCEPTED. Added under Risks (0 dual members; WS1 resolves).
- F6 (minor) — ACKNOWLEDGED; fixture and case (e) are consistent.
- Q1 — Yes: S-M merges and applies before A; the timestamp makes the order mechanical.
- Q2 — See F3.

## Partner rounds (verbatim)

# Partner output — round 1 (verbatim)

I now have enough evidence to write my findings.

## Verified premises

- **Claim: `user_tenants_update_own` policy is `FOR UPDATE TO authenticated USING (user_id = auth.uid())` with no WITH CHECK, created at migration line 115-116.** TRUE -- `/home/user/vitana-platform/supabase/migrations/20251231000000_vtid_01101_phase_a_bootstrap.sql:115-117` confirms exactly this: `CREATE POLICY user_tenants_update_own ON public.user_tenants FOR UPDATE TO authenticated USING (user_id = auth.uid())` with no WITH CHECK clause and no column restriction. A member can rewrite any column on their own row.

- **Claim: `requireTenantAdmin` at `:120-133` admits a caller when `user_tenants.active_role === 'admin'` with no permitted-role check.** TRUE -- `/home/user/vitana-platform/services/gateway/src/middleware/require-tenant-admin.ts:120-133` calls `getCallerRole` which reads `user_tenants.active_role` via `require-tenant-admin-repository.ts:21-27` and checks `callerRole !== 'admin'`. No `user_permitted_roles` or `memberships` query is consulted.

- **Claim: v1 role switch uses `supabase.rpc('set_role_preference')` and never writes `role_preferences` directly.** TRUE -- `/home/user/vitana-v1/src/hooks/useRole.tsx:67` calls `supabase.rpc("set_role_preference", { p_tenant_id, p_role })`. Grep across `vitana-v1/src/` and `vitana-v1/supabase/functions/` for `.from('role_preferences').insert|update|upsert|delete` returns zero matches.

- **Claim: `resolveEffectiveRole` at `orb-live.ts:813-826` picks the role from preference/active_role without intersecting with the permitted set.** TRUE -- `/home/user/vitana-platform/services/gateway/src/routes/orb-live.ts:813-826` runs `fetchUserRolePreference` and `fetchUserActiveRole` in parallel, then calls `pickEffectiveRole`. No `user_permitted_roles` or `memberships` query. No exafy_admin exemption parameter.

- **Claim: `role_preferences` has INSERT/UPDATE/DELETE policies named `rp_upsert_self`, `rp_update_self`, `rp_delete_self` checking only `auth.uid() = user_id`.** TRUE (from live DB dump) -- `/home/user/vitana-platform/scripts/aws/aurora-restore-rls-parity.sql:1437-1439` shows these three policies with no role or tenant check. They are not in any checked-in migration (likely created via dashboard or an early uncaptured migration), which also means the `DROP POLICY IF EXISTS` approach is safe.

## Findings

**F1 [blocker] Migration number `20261014000100` collides with the A-tenant-foundation sibling slice.**

Evidence: This plan uses `supabase/migrations/20261014000100_vtid_XXXXX_s_m_membership_role_lockdown.sql`. The concurrently-sparred A-tenant-foundation slice (`/tmp/claude-0/-home-user/381e2852-9bcc-53fc-81b0-c92afb514bf5/scratchpad/mt-m0/A-tenant-foundation.md:6`) uses `supabase/migrations/20261014000100_vtid_XXXXX_tenants_default_platform_flags.sql`. Both cannot exist. Supabase migrations are ordered by timestamp prefix; a collision means exactly one can be applied.

Suggestion: Since S-M is Track S (expedited security hotfix, fix first), give it a LOWER timestamp so it runs first -- e.g. `20261013200100` (evening of the 13th), or use the sibling-coordination note to reserve a range. The A-tenant-foundation plan should then start at 000100 or later, with S-M already applied.

**F2 [major] `resolveEffectiveRole` signature change is under-specified for `OrbToolIdentity` plumbing.**

Evidence: The plan says callers of `resolveEffectiveRole` will pass `exafy_admin` (C3 item 4, listing `orb-tool.ts:75`, `live-session-controller.ts:184`, `orb-live.ts:18320`). Currently `orb-tool.ts:74-76` calls `resolveEffectiveRole(userId, tenantId)` and does NOT have `req.identity.exafy_admin` available after the call returns (it builds the `OrbToolIdentity` at `:77-82` without `exafy_admin`). The plan needs to clarify: does `orb-tool.ts` read `req.identity.exafy_admin` and pass it to `resolveEffectiveRole` directly (before building `OrbToolIdentity`), or does `OrbToolIdentity` gain the field? The former is simpler and avoids touching the 77-line shared type. But since `developerGate` at `developer-tools.ts:38-47` reads `id.role` (from `OrbToolIdentity`), the clamped role is what flows into the gate -- no separate `exafy_admin` field on `OrbToolIdentity` is needed for this fix. Confirm this reading explicitly so the implementer doesn't add unnecessary surface.

Suggestion: Add one sentence: "The `exafy_admin` flag is passed as a parameter to `resolveEffectiveRole` at each call site, read from `req.identity.exafy_admin` (or `bootstrapIdentity.exafy_admin`); `OrbToolIdentity` is unchanged."

**F3 [major] The plan does not cover `me_context()` returning an attacker-written `active_role` from `user_active_roles` even after the revoke.**

Evidence: The plan says (C4): "`command-hub.ts requireDeveloperAccess` and `tenant-role-auth.ts`. They read `user_active_roles` through `me_context`, which A3 closes to definer writers that already validate." But `me_context` is a SECURITY DEFINER function. Even after revoking INSERT/UPDATE from `authenticated` on `user_active_roles`, the attack is: (1) BEFORE this migration ships, an attacker writes `user_active_roles` with `active_role='developer'`. (2) AFTER this migration ships, `me_context` still reads that poisoned row. The revoke prevents new writes but does not clean existing data. The 4 rows today are all `community`, but there is a race window between exploitation and migration application.

Suggestion: Add to the pre-apply checks: assert `user_active_roles` has no row with `active_role` outside `{'community'}` for non-exafy users (the plan already does this for `user_tenants` and `role_preferences` but not explicitly for `user_active_roles`). If a violator is found, it is the same "exploitation signal: stop, investigate" protocol the plan already describes for `user_tenants`.

**F4 [minor] The plan says `set_role_preference` body is taken "verbatim from `pg_get_functiondef` on 2026-10-13, last defined in `20260925120000_vtid_04561_one_role_truth.sql`" but does not mention `20261010180200_vtid_05043_s3_switch_tenant_open_signup_only.sql` which also references `role_preferences`.**

Evidence: `/home/user/vitana-platform/supabase/migrations/20261010180200_vtid_05043_s3_switch_tenant_open_signup_only.sql:86-88` does an `INSERT INTO role_preferences` inside `switch_to_tenant_by_slug`, which is a different SECURITY DEFINER function (not `set_role_preference`). That function writes to `role_preferences` directly. The plan correctly says `switch_to_tenant_by_slug` is unchanged and is a definer function that runs as owner, so the REVOKE does not affect it. This is not a bug, but the plan should acknowledge this specific migration's `role_preferences` write to avoid confusion during review.

Suggestion: Add to section A6 (unchanged functions): "... `switch_to_tenant_by_slug` (which also writes `role_preferences` directly at VTID-05043:86-88 -- unaffected because it runs as owner)."

**F5 [minor] The `community` bypass in `set_role_preference` creates a subtle cross-tenant data inconsistency even after the membership check.**

Evidence: The plan adds a membership check `NOT EXISTS (SELECT 1 FROM user_tenants WHERE user_id = auth.uid() AND tenant_id = p_tenant_id)`. After this, a member can `set_role_preference(own_tenant, 'community')` (their own membership) which is fine. But if a member belongs to two tenants (T_A and T_B, the ab_dual case in the program plan), calling `set_role_preference(T_B, 'community')` while their session is in T_A would create/update a `role_preferences` row for T_B, which is harmless (it's `community` in their own tenant) but does update `user_active_roles` to `community` as well (lines 68-72 of the function), which is a global table (no tenant column). This means a T_A session switching to `community` in T_B clobbers the active role. The plan correctly notes "0 such users today" and defers multi-membership to WS1, so this is acknowledged risk, not a missed case. Note it explicitly.

Suggestion: No code change needed, but add under Risks: "Multi-tenant dual members calling `set_role_preference` for a non-active tenant clobber `user_active_roles` (global, no tenant column). Affects 0 users today; the single-role-source-of-truth unification in WS1 resolves this."

**F6 [minor] Test harness case (e) uses `set_role_preference(T_B, 'community')` but T_B is `closed` (not `open_signup`). The membership check will pass IF the fixture gives M a `user_tenants` row in T_B; if it doesn't (M is only in T_A per the fixture description), case (e) raises "Not a member" -- which is correct. But the fixture description says "Users: member M (T_A, community, permitted `professional`)" only in T_A. Confirm case (e) and its expected error are consistent with the fixture.**

Evidence: Test section, case (e): `set_role_preference(T_B,'community')` raises "Not a member". Fixture: M is in T_A only. The membership check `NOT EXISTS (... AND tenant_id = p_tenant_id)` would fire because M has no T_B row. This is consistent. No issue, just confirming the reading.

Suggestion: None needed.

## Questions for the planner

1. On F1: will S-M merge and apply before A-tenant-foundation? If so, pick a timestamp that sorts before 20261014000100 to make the ordering constraint explicit and mechanical.

2. On F3: does the pre-apply check already cover `user_active_roles` rows with escalated roles, or only `user_tenants` and `role_preferences`? The plan's "Problem 7" data section lists "4 rows, all community" for `user_active_roles`, but the pre-apply STOP conditions at the end only mention `user_tenants` and `role_preferences` explicitly.

## Verdict

**NOT CONVERGED** -- F1 (migration number collision) is a blocker. F2 and F3 are majors that need explicit answers. All three are addressable with plan text changes only (no design rethink needed).

# Partner output — round 2 (verbatim)

## Round 1 findings — disposition

- **F1 [blocker]** migration number collision -- **closed.** Migration renamed to `20261013200000` (line 4, 157), mechanically sorts before A-tenant-foundation's `20261014000100`. Planner response at line 284 confirms merge and apply ordering.

- **F2 [major]** `OrbToolIdentity` plumbing under-specified -- **closed.** Line 145 now explicitly states the `exafy_admin` flag is a call argument read from `req.identity.exafy_admin` / `bootstrapIdentity.exafy_admin`; `OrbToolIdentity` is unchanged because `developerGate` reads the already-clamped `id.role`.

- **F3 [major]** `user_active_roles` poisoned rows survive the revoke -- **closed.** Line 163 now includes `user_active_roles` in the pre-apply STOP conditions (non-exafy rows outside `{community}` not in permitted set) AND re-runs the same STOP queries immediately after apply to close the pre-check-to-revoke window.

- **F4 [minor]** `switch_to_tenant_by_slug`'s own `role_preferences` write unmentioned -- **closed.** Line 122 now names it explicitly with the VTID-05043 reference.

- **F5 [minor]** dual-member `user_active_roles` clobber -- **closed.** Line 263 added as a risk with "0 dual members today; resolved by WS1."

- **F6 [minor]** test case (e) consistency -- **closed.** Acknowledged; fixture and expected error are consistent.

- **Q1** -- **closed.** Answered: S-M merges and applies first; the timestamp makes it mechanical.

- **Q2** -- **closed.** Answered by F3 resolution.

## New findings from revision

None. The revision is textual -- migration timestamp, explicit sentences for F2/F3/F4/F5 -- and introduces no new design, no new files, no new scope. All changes are consistent with the round 1 plan structure.

## Verified premises

(Carried from round 1, unchanged.)

- `user_tenants_update_own` no WITH CHECK -- TRUE, `20251231000000_vtid_01101_phase_a_bootstrap.sql:115-117`
- `requireTenantAdmin` trusts `user_tenants.active_role` without permitted-role check -- TRUE, `require-tenant-admin.ts:120-133`, `require-tenant-admin-repository.ts:21-27`
- v1 role switch via RPC only -- TRUE, `useRole.tsx:67`
- `resolveEffectiveRole` has no permitted-role intersection -- TRUE, `orb-live.ts:813-826`

## Findings

(No new findings.)

## Questions for the planner

(None.)

## Verdict

**CONVERGED** -- all blockers and majors from round 1 are closed with verified plan text changes. No new issues introduced by the revision. The plan is ready for Gate 1.

## Verdict and record
- Round 1: NOT CONVERGED (F1 blocker, F2/F3 major, F4–F6 minor, Q1–Q2). Every finding answered in
  "Planner responses — round 1" above.
- Round 2 (same partner): all round-1 findings closed, no new findings. Verdict: **CONVERGED**.
- Final plan hash recorded on the sparring record (`final_plan_hash`, read-only check 2026-10-13):
  `35477af685c91243b0a44056eafabc5c479f2ed3186adf4a59825581f68d76ef`.
- Canonical hash (`services/gateway/src/services/plan-sparring/canonical-hash.ts`) of the plan body as
  committed above: `b75d8344d4602b784aab0ed3f255ee9f04080c6800b57ff4718bdf70456dd9c3`. The two differ: the
  plan file was re-laid-out (lists) after the hash was recorded; the implementation followed the
  committed text. Noted for the orchestrator, not resolved here.

## Owner approval
Owner approval (Gate 1): "Yes" — 2026-10-13, Claude Code session; plan hash 35477af685c91243b0a44056eafabc5c479f2ed3186adf4a59825581f68d76ef (computed before VTID substitution); sparring record cc98a8e9-2d86-4286-a19e-5e828e66163a.
