-- mt-guardrails-r2 / local-test-stack: synthetic tenants and members for the
-- disposable local stack ONLY (docs/multitenancy/LOCAL-STACK.md). Never load
-- this into a shared or live database.
--
-- Idempotent: every INSERT is ON CONFLICT DO NOTHING, so loading it twice
-- leaves the same rows.
--
-- Table guards: public.tenants, public.user_tenants and auth.users are
-- required; if the replay did not create one of them the load fails here,
-- with the missing name. Every other table is optional: its insert runs only
-- when to_regclass finds the table, otherwise a NOTICE is printed and the
-- load goes on. Users go into the auth.users table the
-- supabase/postgres image pre-installs; this file never creates auth.users
-- (unlike vtid-05149-tenant-foundation.test.sql, which targets postgres:16).
--
-- Fixed synthetic ids:
--   T_A      0a000000-0000-4000-8000-00000000000a
--   T_B      0b000000-0000-4000-8000-00000000000b
--   a_member 0a000000-0000-4000-8000-0000000000a1  (T_A community)
--   a_admin  0a000000-0000-4000-8000-0000000000a2  (T_A admin)
--   b_member 0b000000-0000-4000-8000-0000000000b1  (T_B community)
--   b_admin  0b000000-0000-4000-8000-0000000000b2  (T_B admin)
--   ab_dual  0ab00000-0000-4000-8000-000000000ab1  (T_A + T_B community, primary T_A)
-- Canary marker (T_A rows only): CANARY_A_0a000000-0000-4000-8000-00000000ca01

-- Required tables: fail loudly when one is missing.
DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.tenants', 'public.user_tenants', 'auth.users'] LOOP
    IF to_regclass(t) IS NULL THEN
      missing := missing || t;
    END IF;
  END LOOP;
  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'fixture: required table(s) missing after the replay: %', array_to_string(missing, ', ');
  END IF;
END
$$;

-- Tenants. The T_A name carries the canary marker, so it is present whatever
-- the replay produced.
INSERT INTO public.tenants (id, slug, name)
VALUES
  ('0a000000-0000-4000-8000-00000000000a', 'mt-fixture-t-a', 'T_A CANARY_A_0a000000-0000-4000-8000-00000000ca01'),
  ('0b000000-0000-4000-8000-00000000000b', 'mt-fixture-t-b', 'T_B')
ON CONFLICT DO NOTHING;

-- Members, into the pre-existing auth.users.
INSERT INTO auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES
  ('0a000000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a_member@vitanatest.exafy.io', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('0a000000-0000-4000-8000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a_admin@vitanatest.exafy.io',  '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('0b000000-0000-4000-8000-0000000000b1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b_member@vitanatest.exafy.io', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('0b000000-0000-4000-8000-0000000000b2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b_admin@vitanatest.exafy.io',  '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('0ab00000-0000-4000-8000-000000000ab1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ab_dual@vitanatest.exafy.io',  '{}'::jsonb, '{}'::jsonb, now(), now())
ON CONFLICT DO NOTHING;

-- user_tenants.user_id references public.app_users; a signup trigger may
-- already have created these rows, hence ON CONFLICT. Optional table.
DO $$
BEGIN
  IF to_regclass('public.app_users') IS NOT NULL THEN
    INSERT INTO public.app_users (user_id, email, display_name)
    VALUES
      ('0a000000-0000-4000-8000-0000000000a1', 'a_member@vitanatest.exafy.io', 'a_member'),
      ('0a000000-0000-4000-8000-0000000000a2', 'a_admin@vitanatest.exafy.io',  'a_admin'),
      ('0b000000-0000-4000-8000-0000000000b1', 'b_member@vitanatest.exafy.io', 'b_member'),
      ('0b000000-0000-4000-8000-0000000000b2', 'b_admin@vitanatest.exafy.io',  'b_admin'),
      ('0ab00000-0000-4000-8000-000000000ab1', 'ab_dual@vitanatest.exafy.io',  'ab_dual')
    ON CONFLICT DO NOTHING;
  ELSE
    RAISE NOTICE 'fixture: public.app_users absent, no app_users rows written';
  END IF;
END
$$;

INSERT INTO public.user_tenants (tenant_id, user_id, active_role, is_primary)
VALUES
  ('0a000000-0000-4000-8000-00000000000a', '0a000000-0000-4000-8000-0000000000a1', 'community', true),
  ('0a000000-0000-4000-8000-00000000000a', '0a000000-0000-4000-8000-0000000000a2', 'admin',     true),
  ('0b000000-0000-4000-8000-00000000000b', '0b000000-0000-4000-8000-0000000000b1', 'community', true),
  ('0b000000-0000-4000-8000-00000000000b', '0b000000-0000-4000-8000-0000000000b2', 'admin',     true),
  ('0a000000-0000-4000-8000-00000000000a', '0ab00000-0000-4000-8000-000000000ab1', 'community', true),
  ('0b000000-0000-4000-8000-00000000000b', '0ab00000-0000-4000-8000-000000000ab1', 'community', false)
ON CONFLICT DO NOTHING;

-- Representative T_A rows carrying the canary marker, written only when the
-- replay created the target table.
DO $$
BEGIN
  IF to_regclass('public.community_groups') IS NOT NULL THEN
    INSERT INTO public.community_groups (id, tenant_id, name, topic_key, description)
    VALUES (
      '0a000000-0000-4000-8000-00000000c601',
      '0a000000-0000-4000-8000-00000000000a',
      'CANARY_A_0a000000-0000-4000-8000-00000000ca01',
      'mt_fixture',
      'CANARY_A_0a000000-0000-4000-8000-00000000ca01'
    )
    ON CONFLICT DO NOTHING;
  ELSE
    RAISE NOTICE 'fixture: public.community_groups absent, no canary row written';
  END IF;
END
$$;
