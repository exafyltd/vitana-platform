-- rollback-sparring-schema.sql — undoes restore-sparring.manifest on Aurora STAGING (one transaction).
-- psql variables, replayed by restore-sparring-schema.sh --rollback from the state file written BEFORE the apply
-- (prestate-sparring.sql):
--   drop_roles          roles the restore CREATED (never a role that existed before)
--   revoke_memberships  request roles authenticator was NOT a member of before (pre-existing memberships are kept)
--   revoke_usage        request roles without an explicit USAGE grant on schema public before (pre-existing grants kept)
--   drop_schemas        schemas the restore created (none in this restore; kept for completeness)
-- Refuses if any table outside the restore set exists in public (someone has used the database since).
\set ON_ERROR_STOP 1
SET client_min_messages = warning;
SELECT set_config('vitana.drop_roles', :'drop_roles', false), set_config('vitana.revoke_memberships', :'revoke_memberships', false),
       set_config('vitana.revoke_usage', :'revoke_usage', false), set_config('vitana.drop_schemas', :'drop_schemas', false);
DO $$
DECLARE
  known text[] := ARRAY['vtid_ledger','plan_sparring_sessions','plan_sparring_config','plan_sparring_shadow_log','pm_digests','pm_lease'];
  request text[] := ARRAY['anon','authenticated','service_role','vitana_governance_owner'];
  extra text; r text; s text; f record;
  list text[];
BEGIN
  SELECT string_agg(tablename, ',') INTO extra FROM pg_tables WHERE schemaname = 'public' AND NOT (tablename = ANY (known));
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'rollback refused: public has tables outside the restore set: %', extra;
  END IF;
  -- the state file may only name the restore's own roles
  list := coalesce(string_to_array(nullif(current_setting('vitana.drop_roles'), ''), ','), '{}')
       || coalesce(string_to_array(nullif(current_setting('vitana.revoke_memberships'), ''), ','), '{}')
       || coalesce(string_to_array(nullif(current_setting('vitana.revoke_usage'), ''), ','), '{}');
  FOREACH r IN ARRAY list LOOP
    IF NOT (r = ANY (request)) THEN RAISE EXCEPTION 'rollback refused: % is not a role of this restore', r; END IF;
  END LOOP;
  -- objects (every overload of the restore's functions, then its tables and sequence)
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace
             AND p.proname IN ('allocate_global_vtid','plan_sparring_append_round','plan_sparring_check',
                               '_plan_sparring_gate_eval','_plan_sparring_mode','_plan_sparring_sessions_touch',
                               'plan_sparring_trigger_status','submit_plan_sparring_record')
  LOOP
    EXECUTE format('DROP FUNCTION %s CASCADE', f.sig);
  END LOOP;
  EXECUTE 'DROP TABLE IF EXISTS public.pm_digests, public.pm_lease, public.plan_sparring_shadow_log, '
       || 'public.plan_sparring_config, public.plan_sparring_sessions, public.vtid_ledger CASCADE';
  EXECUTE 'DROP SEQUENCE IF EXISTS public.global_vtid_seq';
  FOREACH s IN ARRAY coalesce(string_to_array(nullif(current_setting('vitana.drop_schemas'), ''), ','), '{}'::text[]) LOOP
    EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', s);
  END LOOP;
  -- grants the restore added
  FOREACH r IN ARRAY coalesce(string_to_array(nullif(current_setting('vitana.revoke_memberships'), ''), ','), '{}'::text[]) LOOP
    IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
                WHERE g.rolname = r AND u.rolname = 'authenticator') THEN
      EXECUTE format('REVOKE %I FROM authenticator', r);
    END IF;
  END LOOP;
  FOREACH r IN ARRAY coalesce(string_to_array(nullif(current_setting('vitana.revoke_usage'), ''), ','), '{}'::text[]) LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE USAGE ON SCHEMA public FROM %I', r);
    END IF;
  END LOOP;
  -- roles the restore created
  FOREACH r IN ARRAY coalesce(string_to_array(nullif(current_setting('vitana.drop_roles'), ''), ','), '{}'::text[]) LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', r);
      EXECUTE format('DROP ROLE %I', r);
    END IF;
  END LOOP;
END $$;
SELECT 'public_tables_after_rollback', count(*) FROM pg_tables WHERE schemaname = 'public';
