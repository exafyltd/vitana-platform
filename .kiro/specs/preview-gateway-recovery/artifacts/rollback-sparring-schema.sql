-- rollback-sparring-schema.sql — undoes restore-sparring.manifest on Aurora STAGING (one transaction).
-- psql variables (set by restore-sparring-schema.sh --rollback from the pre-apply state file):
--   drop_roles    comma-separated roles the restore CREATED (never a role that existed before the restore)
--   drop_schemas  comma-separated schemas the restore CREATED (auth, storage, extensions; only those absent before)
-- Refuses if any table outside the restore set exists in public (someone has used the database since).
\set ON_ERROR_STOP 1
SET client_min_messages = warning;
SELECT set_config('vitana.drop_roles', :'drop_roles', false), set_config('vitana.drop_schemas', :'drop_schemas', false);
DO $$
DECLARE
  known text[] := ARRAY['vtid_ledger','plan_sparring_sessions','plan_sparring_config','plan_sparring_shadow_log','pm_digests','pm_lease'];
  extra text;
  r text; s text; f record;
BEGIN
  SELECT string_agg(tablename, ',') INTO extra FROM pg_tables WHERE schemaname = 'public' AND NOT (tablename = ANY (known));
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'rollback refused: public has tables outside the restore set: %', extra;
  END IF;
  -- functions created by the restore (every overload)
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
  FOREACH r IN ARRAY coalesce(string_to_array(nullif(current_setting('vitana.drop_roles'), ''), ','), '{}'::text[]) LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', r);
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
        EXECUTE format('REVOKE %I FROM authenticator', r);
      END IF;
      EXECUTE format('DROP ROLE %I', r);
    END IF;
  END LOOP;
END $$;
SELECT 'public_tables_after_rollback', count(*) FROM pg_tables WHERE schemaname = 'public';
