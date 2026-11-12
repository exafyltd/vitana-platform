-- VTID-05467 (mt-identity-r2 / role-source-and-bootstrap, R1): pgTAP for the one selected-role source.
-- Runs with `supabase test db` on the local stack after 20261102033000_vtid_05467_single_role_source.sql, and with the
-- PGlite shim in docs/validation/VTID-05467/pglite-check.mjs. One transaction, rolled back at the end.
--
-- Covers: role_preferences follows user_tenants.active_role on insert and on change; setting active_role to admin
-- derives no grant (user_permitted_roles) and the gate's permitted set still lacks admin; client roles have no write
-- privilege on the four role tables; set_role_preference and me_set_active_role write the selected role to
-- user_tenants (and keep the Command Hub copy, user_active_roles); a refused switch writes nothing.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(28);

-- Fixtures. Fixed ids, used only by this file. The tenant is created here and rolled back at the end.
INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data) VALUES
  ('05467000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'm-05467@example.test', '{}'),
  ('05467000-0000-4000-8000-0000000000a2', 'authenticated', 'authenticated', 'n-05467@example.test', '{}'),
  ('05467000-0000-4000-8000-0000000000a3', 'authenticated', 'authenticated', 'x-05467@example.test', '{"exafy_admin": true}');

INSERT INTO public.app_users (user_id, email, display_name) VALUES
  ('05467000-0000-4000-8000-0000000000a1', 'm-05467@example.test', 'VTID-05467 member'),
  ('05467000-0000-4000-8000-0000000000a2', 'n-05467@example.test', 'VTID-05467 non-member'),
  ('05467000-0000-4000-8000-0000000000a3', 'x-05467@example.test', 'VTID-05467 exafy admin')
ON CONFLICT (user_id) DO NOTHING;

DO $fx$
DECLARE
  r jsonb;
BEGIN
  INSERT INTO public.tenants (name, slug)
  VALUES ('VTID-05467 role test tenant', 'vtid-05467-role-test')
  RETURNING to_jsonb(tenants.*) INTO r;
  PERFORM set_config('vtid05467.tenant', coalesce(r ->> 'tenant_id', r ->> 'id'), true);
END
$fx$;

SELECT set_config('vtid05467.m', '05467000-0000-4000-8000-0000000000a1', true),
       set_config('vtid05467.n', '05467000-0000-4000-8000-0000000000a2', true),
       set_config('vtid05467.x', '05467000-0000-4000-8000-0000000000a3', true);

-- M is a member of the tenant (not primary, so no side-effect trigger runs) with a grant for 'developer'.
-- N has the same grant but no membership. X is an exafy admin with no membership.
INSERT INTO public.user_tenants (tenant_id, user_id, active_role, is_primary)
VALUES (current_setting('vtid05467.tenant')::uuid, current_setting('vtid05467.m')::uuid, 'community', false);

INSERT INTO public.user_permitted_roles (user_id, tenant_id, role) VALUES
  (current_setting('vtid05467.m')::uuid, current_setting('vtid05467.tenant')::uuid, 'developer'),
  (current_setting('vtid05467.n')::uuid, current_setting('vtid05467.tenant')::uuid, 'developer');

-- A. Shape and client privileges ------------------------------------------------------------------------------------
SELECT ok(EXISTS (
  SELECT 1 FROM pg_trigger
   WHERE tgrelid = 'public.user_tenants'::regclass
     AND tgname = 'user_tenants_derive_role_preference'
     AND tgenabled <> 'D'
), 'the derivation trigger is on user_tenants and enabled');

SELECT ok(CASE WHEN to_regprocedure('public.user_tenants_derive_role_preference()') IS NULL THEN false
               ELSE NOT has_function_privilege('anon', 'public.user_tenants_derive_role_preference()', 'EXECUTE')
                AND NOT has_function_privilege('authenticated', 'public.user_tenants_derive_role_preference()', 'EXECUTE')
          END,
  'the derivation function exists and is not executable by anon or authenticated');

SELECT ok(NOT (has_table_privilege('authenticated', 'public.user_tenants', 'INSERT')
            OR has_table_privilege('authenticated', 'public.user_tenants', 'UPDATE')
            OR has_table_privilege('authenticated', 'public.user_tenants', 'DELETE')
            OR has_table_privilege('authenticated', 'public.user_tenants', 'TRUNCATE')),
  'authenticated has no write privilege on user_tenants');

SELECT ok(NOT (has_table_privilege('authenticated', 'public.role_preferences', 'INSERT')
            OR has_table_privilege('authenticated', 'public.role_preferences', 'UPDATE')
            OR has_table_privilege('authenticated', 'public.role_preferences', 'DELETE')
            OR has_table_privilege('authenticated', 'public.role_preferences', 'TRUNCATE')),
  'authenticated has no write privilege on role_preferences');

SELECT ok(NOT (has_table_privilege('authenticated', 'public.user_permitted_roles', 'INSERT')
            OR has_table_privilege('authenticated', 'public.user_permitted_roles', 'UPDATE')
            OR has_table_privilege('authenticated', 'public.user_permitted_roles', 'DELETE')
            OR has_table_privilege('authenticated', 'public.user_permitted_roles', 'TRUNCATE')),
  'authenticated has no write privilege on user_permitted_roles (the grant store)');

SELECT ok(NOT (has_table_privilege('authenticated', 'public.user_active_roles', 'INSERT')
            OR has_table_privilege('authenticated', 'public.user_active_roles', 'UPDATE')
            OR has_table_privilege('authenticated', 'public.user_active_roles', 'DELETE')
            OR has_table_privilege('authenticated', 'public.user_active_roles', 'TRUNCATE')),
  'authenticated has no write privilege on user_active_roles');

-- B. Derivation and the grant store (owner context) ------------------------------------------------------------------
SELECT is((SELECT role FROM public.role_preferences
            WHERE user_id = current_setting('vtid05467.m')::uuid
              AND tenant_id = current_setting('vtid05467.tenant')::uuid),
  'community', 'a new membership derives its preference row from active_role');

UPDATE public.user_tenants SET active_role = 'professional'
 WHERE user_id = current_setting('vtid05467.m')::uuid
   AND tenant_id = current_setting('vtid05467.tenant')::uuid;

SELECT is((SELECT role FROM public.role_preferences
            WHERE user_id = current_setting('vtid05467.m')::uuid
              AND tenant_id = current_setting('vtid05467.tenant')::uuid),
  'professional', 'a change of active_role is derived into role_preferences');

UPDATE public.user_tenants SET active_role = 'admin'
 WHERE user_id = current_setting('vtid05467.m')::uuid
   AND tenant_id = current_setting('vtid05467.tenant')::uuid;

SELECT is((SELECT role FROM public.role_preferences
            WHERE user_id = current_setting('vtid05467.m')::uuid
              AND tenant_id = current_setting('vtid05467.tenant')::uuid),
  'admin', 'the derivation follows the selected role, admin included');

SELECT is((SELECT count(*)::text FROM public.user_permitted_roles
            WHERE user_id = current_setting('vtid05467.m')::uuid AND role = 'admin'),
  '0', 'setting active_role to admin derives no grant row');

SELECT ok(
  NOT EXISTS (SELECT 1 FROM public.user_permitted_roles
               WHERE user_id = current_setting('vtid05467.m')::uuid
                 AND tenant_id = current_setting('vtid05467.tenant')::uuid
                 AND role = 'admin')
  AND NOT EXISTS (SELECT 1 FROM public.memberships
                   WHERE user_id = current_setting('vtid05467.m')::uuid
                     AND tenant_id = current_setting('vtid05467.tenant')::uuid
                     AND role = 'admin'::public.tenant_role
                     AND status = 'active'),
  'the permitted set of M in the tenant has no admin, so the gate refuses M while active_role is admin');

SELECT throws_ok(
  $q$UPDATE public.user_tenants SET active_role = 'bogus'
      WHERE user_id = current_setting('vtid05467.m')::uuid
        AND tenant_id = current_setting('vtid05467.tenant')::uuid$q$,
  '23514', NULL,
  'a selected role outside the preference check is refused (the derivation fails closed)');

SELECT is((SELECT active_role FROM public.user_tenants
            WHERE user_id = current_setting('vtid05467.m')::uuid
              AND tenant_id = current_setting('vtid05467.tenant')::uuid),
  'admin', 'a refused change leaves the selected role as it was');

-- C. The community app's switch (set_role_preference), as the client roles ------------------------------------------
UPDATE public.user_tenants SET active_role = 'community'
 WHERE user_id = current_setting('vtid05467.m')::uuid
   AND tenant_id = current_setting('vtid05467.tenant')::uuid;

SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('vtid05467.m'), 'role', 'authenticated', 'tenant_id', current_setting('vtid05467.tenant'))::text, true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $q$SELECT public.set_role_preference(current_setting('vtid05467.tenant')::uuid, 'admin')$q$,
  'P0001', 'Role not granted for this tenant',
  'a member cannot select admin through the switch (no grant)');

SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('vtid05467.n'), 'role', 'authenticated')::text, true);
SELECT throws_ok(
  $q$SELECT public.set_role_preference(current_setting('vtid05467.tenant')::uuid, 'developer')$q$,
  '42501', 'Not a member of this tenant',
  'a user with a grant but no membership cannot switch in the tenant');

SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('vtid05467.x'), 'role', 'authenticated', 'app_metadata', json_build_object('exafy_admin', true))::text, true);
SELECT throws_ok(
  $q$SELECT public.set_role_preference(current_setting('vtid05467.tenant')::uuid, 'community')$q$,
  '42501', 'Not a member of this tenant',
  'an exafy admin with no membership row in the tenant gets no write (the switch needs a canonical row)');

SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('vtid05467.m'), 'role', 'authenticated', 'tenant_id', current_setting('vtid05467.tenant'))::text, true);
SELECT lives_ok(
  $q$SELECT public.set_role_preference(current_setting('vtid05467.tenant')::uuid, 'developer')$q$,
  'a permitted member selects a role through set_role_preference');

RESET ROLE;

SELECT is((SELECT active_role FROM public.user_tenants
            WHERE user_id = current_setting('vtid05467.m')::uuid
              AND tenant_id = current_setting('vtid05467.tenant')::uuid),
  'developer', 'set_role_preference writes the selected role to user_tenants');

SELECT is((SELECT role FROM public.role_preferences
            WHERE user_id = current_setting('vtid05467.m')::uuid
              AND tenant_id = current_setting('vtid05467.tenant')::uuid),
  'developer', 'the preference row follows the switch');

SELECT is((SELECT active_role FROM public.user_active_roles
            WHERE user_id = current_setting('vtid05467.m')::uuid),
  'developer', 'the Command Hub copy (user_active_roles) is still written in the same transaction');

SELECT ok(EXISTS (
  SELECT 1 FROM public.audit_events
   WHERE user_id = current_setting('vtid05467.m')::uuid
     AND event_type = 'user_role_switch'
     AND event_data ->> 'new_role' = 'developer'
), 'the switch is audited as a user_role_switch');

-- D. The Command Hub's switch (me_set_active_role) ------------------------------------------------------------------
UPDATE public.user_tenants SET active_role = 'community'
 WHERE user_id = current_setting('vtid05467.m')::uuid
   AND tenant_id = current_setting('vtid05467.tenant')::uuid;

SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('vtid05467.m'), 'role', 'authenticated', 'tenant_id', current_setting('vtid05467.tenant'))::text, true);
SET LOCAL ROLE authenticated;

SELECT is((SELECT public.me_set_active_role('developer') ->> 'ok'),
  'true', 'me_set_active_role in a permitted tenant returns ok');

RESET ROLE;

SELECT is((SELECT active_role FROM public.user_tenants
            WHERE user_id = current_setting('vtid05467.m')::uuid
              AND tenant_id = current_setting('vtid05467.tenant')::uuid),
  'developer', 'me_set_active_role writes the selected role to user_tenants');

SELECT is((SELECT role FROM public.role_preferences
            WHERE user_id = current_setting('vtid05467.m')::uuid
              AND tenant_id = current_setting('vtid05467.tenant')::uuid),
  'developer', 'the preference row follows the Command Hub switch');

SELECT is((SELECT active_role FROM public.user_active_roles
            WHERE user_id = current_setting('vtid05467.m')::uuid),
  'developer', 'me_set_active_role still writes the Command Hub copy');

SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('vtid05467.n'), 'role', 'authenticated', 'tenant_id', current_setting('vtid05467.tenant'))::text, true);
SET LOCAL ROLE authenticated;

SELECT is((SELECT public.me_set_active_role('developer') ->> 'error'),
  'NOT_A_MEMBER', 'me_set_active_role refuses a permitted user with no membership row in the tenant');

RESET ROLE;

SELECT is((SELECT count(*)::text FROM public.user_active_roles
            WHERE user_id = current_setting('vtid05467.n')::uuid),
  '0', 'a refused Command Hub switch writes no user_active_roles row');

SELECT is((SELECT count(*)::text FROM public.role_preferences
            WHERE user_id = current_setting('vtid05467.n')::uuid),
  '0', 'a refused Command Hub switch writes no preference row');

SELECT * FROM finish();

ROLLBACK;
