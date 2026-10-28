-- VTID-05147 (Track S / S-M) assertions, run by
-- scripts/ci/test-vtid-05147-s-m-lockdown.sh after the fixture and the
-- migration (applied twice). Every failure RAISEs; ON_ERROR_STOP ends the run.
\set ON_ERROR_STOP 1
\o /dev/null
\set M '00000000-0000-0000-0000-00000000aa01'
\set X '00000000-0000-0000-0000-00000000aa02'
\set N '00000000-0000-0000-0000-00000000aa03'
\set TA '0000000a-0000-0000-0000-000000005147'
\set TB '0000000b-0000-0000-0000-000000005147'

RESET ROLE;
CREATE SCHEMA t05147;
GRANT USAGE ON SCHEMA t05147 TO PUBLIC;

-- Runs p_sql as the current role and requires it to fail with p_state
-- (and, when given, a message containing p_msg).
CREATE FUNCTION t05147.expect_error(p_label text, p_sql text, p_state text, p_msg text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE st text; m text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, m = MESSAGE_TEXT;
    IF p_state IS NOT NULL AND st <> p_state THEN
      RAISE EXCEPTION '%: expected SQLSTATE %, got % (%)', p_label, p_state, st, m;
    END IF;
    IF p_msg IS NOT NULL AND position(p_msg IN m) = 0 THEN
      RAISE EXCEPTION '%: expected "%", got "%"', p_label, p_msg, m;
    END IF;
    RETURN;
  END;
  RAISE EXCEPTION '%: expected an error, the statement succeeded', p_label;
END $$;
GRANT EXECUTE ON FUNCTION t05147.expect_error(text, text, text, text) TO PUBLIC;

CREATE FUNCTION t05147.claims(p_sub text, p_app_meta jsonb) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', p_sub, 'role', 'authenticated', 'app_metadata', p_app_meta)::text, false);
END $$;
GRANT EXECUTE ON FUNCTION t05147.claims(text, jsonb) TO PUBLIC;

-- ---------------------------------------------------------------------------
-- Member M (T_A, community, permitted 'professional')
-- ---------------------------------------------------------------------------
SELECT t05147.claims(:'M', jsonb_build_object('active_tenant_id', :'TA'));
SET ROLE authenticated;

-- (a) cannot rewrite the own membership row: role, tenant, primary flag.
SELECT t05147.expect_error('(a) user_tenants.active_role',
  $$UPDATE public.user_tenants SET active_role = 'admin' WHERE user_id = auth.uid()$$, '42501');
SELECT t05147.expect_error('(a) user_tenants.tenant_id',
  format($$UPDATE public.user_tenants SET tenant_id = %L WHERE user_id = auth.uid()$$, :'TB'), '42501');
SELECT t05147.expect_error('(a) user_tenants.is_primary',
  $$UPDATE public.user_tenants SET is_primary = false WHERE user_id = auth.uid()$$, '42501');
SELECT t05147.expect_error('(a) user_tenants insert',
  format($$INSERT INTO public.user_tenants (tenant_id, user_id, active_role) VALUES (%L, auth.uid(), 'admin')$$, :'TB'), '42501');
SELECT t05147.expect_error('(a) user_tenants delete',
  $$DELETE FROM public.user_tenants WHERE user_id = auth.uid()$$, '42501');

-- (b) no direct writes to role_preferences / user_active_roles / user_permitted_roles.
SELECT t05147.expect_error('(b) role_preferences insert',
  format($$INSERT INTO public.role_preferences (user_id, tenant_id, role) VALUES (auth.uid(), %L, 'developer')$$, :'TB'), '42501');
SELECT t05147.expect_error('(b) role_preferences update',
  $$UPDATE public.role_preferences SET role = 'developer' WHERE user_id = auth.uid()$$, '42501');
SELECT t05147.expect_error('(b) role_preferences delete',
  $$DELETE FROM public.role_preferences WHERE user_id = auth.uid()$$, '42501');
SELECT t05147.expect_error('(b) user_active_roles insert',
  $$INSERT INTO public.user_active_roles (user_id, active_role) VALUES (auth.uid(), 'developer') ON CONFLICT (user_id) DO UPDATE SET active_role = 'developer'$$, '42501');
SELECT t05147.expect_error('(b) user_active_roles update',
  $$UPDATE public.user_active_roles SET active_role = 'developer' WHERE user_id = auth.uid()$$, '42501');
SELECT t05147.expect_error('(b) user_permitted_roles insert',
  format($$INSERT INTO public.user_permitted_roles (user_id, tenant_id, role) VALUES (auth.uid(), %L, 'admin')$$, :'TA'), '42501');

-- (c) the sanctioned switch to a permitted role works and keeps both tables in step.
SELECT public.set_role_preference(:'TA'::uuid, 'professional');
DO $$ BEGIN
  ASSERT (SELECT role FROM public.role_preferences WHERE user_id = auth.uid() AND tenant_id = '0000000a-0000-0000-0000-000000005147') = 'professional',
    '(c) role_preferences reads professional';
  ASSERT (SELECT active_role FROM public.user_active_roles WHERE user_id = auth.uid()) = 'professional',
    '(c) user_active_roles reads professional';
  ASSERT (public.me_context() ->> 'active_role') = 'professional', '(c) me_context serves professional';
END $$;

-- (d) a role that is not granted is refused.
SELECT t05147.expect_error('(d) developer not granted',
  format($$SELECT public.set_role_preference(%L::uuid, 'developer')$$, :'TA'), 'P0001', 'Role not granted for this tenant');
SELECT t05147.expect_error('(d) admin never self-assigned',
  format($$SELECT public.set_role_preference(%L::uuid, 'admin')$$, :'TA'), 'P0001');

-- (e) 'community' is no longer accepted for a tenant the caller is not in.
SELECT t05147.expect_error('(e) community in a foreign tenant',
  format($$SELECT public.set_role_preference(%L::uuid, 'community')$$, :'TB'), '42501', 'Not a member of this tenant');
DO $$ BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM public.role_preferences WHERE user_id = auth.uid() AND tenant_id = '0000000b-0000-0000-0000-000000005147'),
    '(e) no role_preferences row was written for T_B';
END $$;

-- (f) the way back to community always works in the own tenant.
SELECT public.set_role_preference(:'TA'::uuid, 'community');
DO $$ BEGIN
  ASSERT (SELECT role FROM public.role_preferences WHERE user_id = auth.uid() AND tenant_id = '0000000a-0000-0000-0000-000000005147') = 'community',
    '(f) role_preferences back to community';
  ASSERT (SELECT active_role FROM public.user_active_roles WHERE user_id = auth.uid()) = 'community',
    '(f) user_active_roles back to community';
END $$;

-- (g) me_set_active_role still works.
DO $$ BEGIN
  ASSERT (public.me_set_active_role('community') ->> 'ok')::boolean, '(g) me_set_active_role(community) ok';
  ASSERT (public.me_set_active_role('developer') ->> 'ok')::boolean IS FALSE, '(g) me_set_active_role(developer) refused';
END $$;

-- (h) M still reads the own rows.
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM public.user_tenants WHERE user_id = auth.uid()) = 1, '(h) reads own user_tenants';
  ASSERT (SELECT count(*) FROM public.role_preferences WHERE user_id = auth.uid()) = 1, '(h) reads own role_preferences';
  ASSERT (SELECT count(*) FROM public.user_active_roles WHERE user_id = auth.uid()) = 1, '(h) reads own user_active_roles';
  ASSERT (SELECT count(*) FROM public.user_permitted_roles WHERE user_id = auth.uid()) = 1, '(h) reads own user_permitted_roles';
  ASSERT (SELECT count(*) FROM public.role_preferences) = 1, '(h) RLS still hides other users';
END $$;

-- (k) switching to the own tenant works.
SELECT public.switch_to_tenant_by_slug('t-a');

-- (m) a closed tenant stays closed.
SELECT t05147.expect_error('(m) closed tenant',
  $$SELECT public.switch_to_tenant_by_slug('t-b')$$, '42501', 'TENANT_NOT_JOINABLE');

-- Nothing M did changed the own membership row.
RESET ROLE;
DO $$ BEGIN
  ASSERT (SELECT active_role FROM public.user_tenants WHERE user_id = '00000000-0000-0000-0000-00000000aa01') = 'community',
    'M active_role unchanged';
  ASSERT (SELECT count(*) FROM public.user_tenants WHERE user_id = '00000000-0000-0000-0000-00000000aa01'
           AND tenant_id = '0000000a-0000-0000-0000-000000005147' AND is_primary) = 1, 'M membership unchanged';
END $$;

-- ---------------------------------------------------------------------------
-- (l) a new user joins the open tenant through the definer function.
-- ---------------------------------------------------------------------------
SELECT t05147.claims(:'N', '{}'::jsonb);
SET ROLE authenticated;
SELECT public.switch_to_tenant_by_slug('t-a');
RESET ROLE;
DO $$ BEGIN
  ASSERT EXISTS (SELECT 1 FROM public.user_tenants WHERE user_id = '00000000-0000-0000-0000-00000000aa03'
                   AND tenant_id = '0000000a-0000-0000-0000-000000005147' AND active_role = 'community' AND is_primary),
    '(l) new user got a user_tenants row';
  ASSERT EXISTS (SELECT 1 FROM public.role_preferences WHERE user_id = '00000000-0000-0000-0000-00000000aa03' AND role = 'community'),
    '(l) new user got a community role_preferences row';
END $$;

-- ---------------------------------------------------------------------------
-- (i) exafy admin X: any tenant, any role.
-- ---------------------------------------------------------------------------
SELECT t05147.claims(:'X', '{"exafy_admin":true}'::jsonb);
SET ROLE authenticated;
SELECT public.set_role_preference(:'TB'::uuid, 'developer');
DO $$ BEGIN
  ASSERT (SELECT role FROM public.role_preferences WHERE user_id = auth.uid() AND tenant_id = '0000000b-0000-0000-0000-000000005147') = 'developer',
    '(i) exafy admin set developer in T_B';
END $$;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- (j) the gateway (service_role) still writes.
-- ---------------------------------------------------------------------------
SET ROLE service_role;
UPDATE public.user_tenants SET active_role = 'professional' WHERE user_id = '00000000-0000-0000-0000-00000000aa01';
INSERT INTO public.role_preferences (user_id, tenant_id, role)
VALUES ('00000000-0000-0000-0000-00000000aa01', '0000000b-0000-0000-0000-000000005147', 'community');
INSERT INTO public.user_permitted_roles (user_id, tenant_id, role)
VALUES ('00000000-0000-0000-0000-00000000aa01', '0000000a-0000-0000-0000-000000005147', 'staff');
UPDATE public.user_active_roles SET active_role = 'community' WHERE user_id = '00000000-0000-0000-0000-00000000aa01';
RESET ROLE;
DO $$ BEGIN
  ASSERT (SELECT active_role FROM public.user_tenants WHERE user_id = '00000000-0000-0000-0000-00000000aa01') = 'professional',
    '(j) service_role updated user_tenants';
END $$;

-- ---------------------------------------------------------------------------
-- (n) anon cannot execute set_role_preference; a call without a user fails.
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claims', '{"role":"anon"}', false);
SET ROLE anon;
SELECT t05147.expect_error('(n) anon set_role_preference',
  format($$SELECT public.set_role_preference(%L::uuid, 'community')$$, :'TA'), '42501');
SELECT t05147.expect_error('(n) anon user_permitted_roles insert',
  format($$INSERT INTO public.user_permitted_roles (user_id, tenant_id, role) VALUES (%L, %L, 'admin')$$, :'M', :'TA'), '42501');
RESET ROLE;
SET ROLE authenticated;
SELECT t05147.expect_error('(n) authenticated without sub',
  format($$SELECT public.set_role_preference(%L::uuid, 'community')$$, :'TA'), '42501', 'Not authenticated');
RESET ROLE;

-- Static end state (the migration's own self-check passed twice to get here).
DO $$ BEGIN
  ASSERT NOT has_function_privilege('anon', 'public.set_role_preference(uuid, text)', 'EXECUTE'), 'anon EXECUTE revoked';
  ASSERT has_function_privilege('authenticated', 'public.set_role_preference(uuid, text)', 'EXECUTE'), 'authenticated keeps EXECUTE';
  ASSERT NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
    AND policyname IN ('user_tenants_update_own', 'rp_upsert_self', 'rp_update_self', 'rp_delete_self',
                       'user_active_roles_insert', 'user_active_roles_update')), 'the six write policies are gone';
  ASSERT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND policyname = 'memberships_insert_new'),
    'memberships write policies untouched';
  ASSERT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND policyname = 'app_users_owner_write'),
    'app_users_owner_write untouched (WS1 precondition, out of scope)';
  ASSERT has_table_privilege('authenticated', 'public.memberships', 'INSERT'), 'memberships INSERT grant untouched';
  ASSERT NOT has_table_privilege('authenticated', 'public.memberships', 'TRUNCATE'), 'memberships TRUNCATE revoked';
  ASSERT NOT has_table_privilege('anon', 'public.app_users', 'TRUNCATE'), 'app_users TRUNCATE revoked';
END $$;

\echo 'VTID-05147: all assertions passed'
