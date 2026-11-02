-- VTID-05467 (mt-identity-r2 / role-source-and-bootstrap, R2): pgTAP for bootstrap_admin_user on the default tenant.
-- Runs with `supabase test db` on the local stack after 20261102033100_vtid_05467_fix_bootstrap_admin_user.sql, and with
-- the PGlite shim in docs/validation/VTID-05467/pglite-check.mjs. One transaction, rolled back at the end.
--
-- Covers: the signature is unchanged; the body pins no tenant name and keys on tenants.is_default; an exafy admin
-- bootstraps a user into the default tenant even though that tenant is renamed here (no name pin); the grant is a
-- memberships admin row; the canonical user_tenants row exists at once with the selected role left as 'community';
-- the derived preference row exists; the user gets no membership elsewhere; the refusals (non-exafy caller, second
-- bootstrap, no app_users row, unknown user) write nothing.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(20);

-- The default tenant of this database, read without naming its key column (tenant_id or id).
SELECT set_config('vtid05467.default', coalesce(to_jsonb(t) ->> 'tenant_id', to_jsonb(t) ->> 'id'), true)
  FROM public.tenants t
 WHERE t.is_default;

-- Renamed here, so the grant cannot depend on the tenant's name. Rolled back at the end.
UPDATE public.tenants SET name = 'VTID-05467 renamed default' WHERE is_default;

-- U: the target user (has an app_users row). X: the exafy caller. Z: an auth user with no app_users row.
INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data) VALUES
  ('05467000-0000-4000-8000-0000000000b1', 'authenticated', 'authenticated', 'u-05467@example.test', '{}'),
  ('05467000-0000-4000-8000-0000000000b2', 'authenticated', 'authenticated', 'x-b-05467@example.test', '{"exafy_admin": true}'),
  ('05467000-0000-4000-8000-0000000000b3', 'authenticated', 'authenticated', 'z-05467@example.test', '{}');

INSERT INTO public.app_users (user_id, email, display_name) VALUES
  ('05467000-0000-4000-8000-0000000000b1', 'u-05467@example.test', 'VTID-05467 target'),
  ('05467000-0000-4000-8000-0000000000b2', 'x-b-05467@example.test', 'VTID-05467 exafy caller')
ON CONFLICT (user_id) DO NOTHING;

-- Z must have no app_users, membership or preference row, even if an auth-user trigger created one on the local stack.
DELETE FROM public.user_tenants WHERE user_id = '05467000-0000-4000-8000-0000000000b3';
DELETE FROM public.memberships WHERE user_id = '05467000-0000-4000-8000-0000000000b3';
DELETE FROM public.role_preferences WHERE user_id = '05467000-0000-4000-8000-0000000000b3';
DELETE FROM public.app_users WHERE user_id = '05467000-0000-4000-8000-0000000000b3';

SELECT set_config('vtid05467.u', '05467000-0000-4000-8000-0000000000b1', true),
       set_config('vtid05467.x', '05467000-0000-4000-8000-0000000000b2', true),
       set_config('vtid05467.z', '05467000-0000-4000-8000-0000000000b3', true);

-- A. Shape ----------------------------------------------------------------------------------------------------------
SELECT ok(coalesce(current_setting('vtid05467.default', true), '') <> '',
  'the database has a default tenant (tenants.is_default)');

SELECT is((SELECT pg_get_function_identity_arguments('public.bootstrap_admin_user(uuid, text)'::regprocedure)),
  'p_user_id uuid, p_user_email text', 'the signature is unchanged');

SELECT ok(NOT (SELECT prosrc ~ 'Maxina|Alkalma|Earthlings'
                 FROM pg_proc WHERE oid = 'public.bootstrap_admin_user(uuid, text)'::regprocedure),
  'the body pins no tenant name');

SELECT ok((SELECT prosrc LIKE '%is_default%'
             FROM pg_proc WHERE oid = 'public.bootstrap_admin_user(uuid, text)'::regprocedure),
  'the body keys on tenants.is_default');

-- B. Refusal of a non-exafy caller, then the bootstrap by an exafy admin ---------------------------------------------
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('vtid05467.u'), 'role', 'authenticated')::text, true);
SELECT throws_ok(
  $q$SELECT public.bootstrap_admin_user(current_setting('vtid05467.u')::uuid, 'u-05467@example.test')$q$,
  'P0001', 'Only exafy_admin can bootstrap admin users',
  'a non-exafy caller cannot bootstrap');

SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('vtid05467.x'), 'role', 'authenticated', 'app_metadata', json_build_object('exafy_admin', true))::text, true);
SELECT lives_ok(
  $q$SELECT public.bootstrap_admin_user(current_setting('vtid05467.u')::uuid, 'u-05467@example.test')$q$,
  'an exafy admin bootstraps a user into the default tenant');

-- C. The outcome ------------------------------------------------------------------------------------------------------
SELECT is((SELECT role::text FROM public.memberships
            WHERE user_id = current_setting('vtid05467.u')::uuid
              AND tenant_id = current_setting('vtid05467.default')::uuid),
  'admin', 'the grant is a memberships admin row in the default tenant');

SELECT is((SELECT status FROM public.memberships
            WHERE user_id = current_setting('vtid05467.u')::uuid
              AND tenant_id = current_setting('vtid05467.default')::uuid),
  'active', 'the grant is active');

SELECT is((SELECT count(*)::text FROM public.user_tenants
            WHERE user_id = current_setting('vtid05467.u')::uuid
              AND tenant_id = current_setting('vtid05467.default')::uuid),
  '1', 'the canonical user_tenants row exists at once, not only at commit');

SELECT is((SELECT active_role FROM public.user_tenants
            WHERE user_id = current_setting('vtid05467.u')::uuid
              AND tenant_id = current_setting('vtid05467.default')::uuid),
  'community', 'the bootstrap sets no selected role');

SELECT is((SELECT role FROM public.role_preferences
            WHERE user_id = current_setting('vtid05467.u')::uuid
              AND tenant_id = current_setting('vtid05467.default')::uuid),
  'community', 'the derived preference row follows the canonical row');

SELECT is((SELECT count(*)::text FROM public.memberships
            WHERE user_id = current_setting('vtid05467.u')::uuid
              AND tenant_id <> current_setting('vtid05467.default')::uuid),
  '0', 'no membership is written in any other tenant (no name pin)');

SELECT is((SELECT raw_app_meta_data ->> 'exafy_admin' FROM auth.users
            WHERE id = current_setting('vtid05467.u')::uuid),
  'true', 'the target is flagged exafy_admin');

SELECT is((SELECT raw_app_meta_data ->> 'active_tenant_id' FROM auth.users
            WHERE id = current_setting('vtid05467.u')::uuid),
  current_setting('vtid05467.default'), 'the default tenant becomes the active tenant');

SELECT ok(EXISTS (
  SELECT 1 FROM public.audit_events
   WHERE event_type = 'admin_bootstrap_success'
     AND tenant_id = current_setting('vtid05467.default')::uuid
     AND event_data ->> 'target_user_id' = current_setting('vtid05467.u')
), 'the success is audited against the default tenant');

SELECT is((SELECT name FROM public.tenants WHERE is_default), 'VTID-05467 renamed default',
  'the default tenant was renamed in this test, so the grant did not depend on its name');

-- D. Refusals (the caller stays the exafy admin X) -------------------------------------------------------------------
SELECT throws_ok(
  $q$SELECT public.bootstrap_admin_user(current_setting('vtid05467.u')::uuid, 'u-05467@example.test')$q$,
  'P0001', NULL,
  'a second bootstrap of an admin is refused');

SELECT throws_ok(
  $q$SELECT public.bootstrap_admin_user(current_setting('vtid05467.z')::uuid, 'z-05467@example.test')$q$,
  'P0001', NULL,
  'a target with no app_users row is refused');

SELECT throws_ok(
  $q$SELECT public.bootstrap_admin_user('05467000-0000-4000-8000-0000000000ff'::uuid, 'nobody-05467@example.test')$q$,
  'P0001', NULL,
  'an unknown target user is refused');

SELECT is((SELECT count(*)::text FROM public.memberships
            WHERE user_id = current_setting('vtid05467.z')::uuid)
        || '/' || (SELECT count(*)::text FROM public.user_tenants
            WHERE user_id = current_setting('vtid05467.z')::uuid),
  '0/0', 'a refused bootstrap writes no membership or user_tenants row');

SELECT * FROM finish();

ROLLBACK;
