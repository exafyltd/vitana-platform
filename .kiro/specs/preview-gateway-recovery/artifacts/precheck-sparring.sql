-- precheck-sparring.sql — READ-ONLY. Runs first in restore-sparring-schema.sh (dry run and --apply) and in
-- rehearse-restore.sh. Prints what can be verified before the restore; raises (refuses) when the restore could fail or
-- when anything it would create already exists — so --rollback can only ever remove objects this restore created.
\set ON_ERROR_STOP 1
SELECT 'server_version', current_setting('server_version');
SELECT 'database', current_database();
SELECT 'connected_as', current_user;
SELECT 'master_attributes', format('superuser=%s createrole=%s createdb=%s bypassrls=%s', rolsuper, rolcreaterole, rolcreatedb, rolbypassrls)
  FROM pg_roles WHERE rolname = current_user;
SELECT 'master_member_of', coalesce(string_agg(r.rolname, ',' ORDER BY r.rolname), '(none)')
  FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles me ON me.oid = m.member WHERE me.rolname = current_user;
SELECT 'database_owner', pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database();
SELECT 'can_create_in_schema_public', has_schema_privilege(current_user, 'public', 'CREATE');
SELECT 'public_tables', count(*) FROM pg_tables WHERE schemaname = 'public';
SELECT 'public_functions', count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace;
SELECT 'public_sequences', count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'S';
SELECT 'role_' || r.n, CASE WHEN p.oid IS NULL THEN 'absent' ELSE 'PRESENT' END
  FROM (VALUES ('anon'), ('authenticated'), ('service_role'), ('vitana_governance_owner')) r(n)
  LEFT JOIN pg_roles p ON p.rolname = r.n ORDER BY 1;
SELECT 'authenticator', CASE WHEN p.oid IS NULL THEN 'ABSENT' ELSE format('login=%s inherit=%s superuser=%s bypassrls=%s', p.rolcanlogin, p.rolinherit, p.rolsuper, p.rolbypassrls) END
  FROM (VALUES ('authenticator')) r(n) LEFT JOIN pg_roles p ON p.rolname = r.n;
SELECT 'authenticator_member_of', coalesce(string_agg(r.rolname, ',' ORDER BY r.rolname), '(none)')
  FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = 'authenticator';
SELECT 'schemas_auth_storage_extensions', coalesce(string_agg(nspname, ',' ORDER BY nspname), '(none)')
  FROM pg_namespace WHERE nspname IN ('auth', 'storage', 'extensions');
DO $$
BEGIN
  IF current_setting('server_version_num')::int < 160000 THEN
    RAISE EXCEPTION 'refused: PostgreSQL % < 16 (the rehearsal proved the role rules of 16+)', current_setting('server_version');
  END IF;
  IF current_database() <> 'vitana' THEN RAISE EXCEPTION 'refused: database is %, expected vitana', current_database(); END IF;
  IF NOT (SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'refused: % has no CREATEROLE (use the cluster master user)', current_user;
  END IF;
  IF NOT has_schema_privilege(current_user, 'public', 'CREATE') THEN
    RAISE EXCEPTION 'refused: % cannot CREATE in schema public', current_user;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    RAISE EXCEPTION 'refused: role authenticator (PostgREST login) does not exist';
  END IF;
  -- Nothing the restore creates may exist already: then --rollback provably removes only restore-created objects.
  IF (SELECT count(*) FROM pg_tables WHERE schemaname = 'public') <> 0 THEN
    RAISE EXCEPTION 'refused: public schema has tables; this restore only runs on the empty staging database';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace) THEN
    RAISE EXCEPTION 'refused: public schema has functions (%); stop and report', (SELECT string_agg(proname, ',') FROM pg_proc WHERE pronamespace = 'public'::regnamespace);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace) THEN
    RAISE EXCEPTION 'refused: public schema has relations (sequences/views); stop and report';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role','vitana_governance_owner')) THEN
    RAISE EXCEPTION 'refused: role(s) % already exist; stop and report (rollback scope would not be exact)',
      (SELECT string_agg(rolname, ',') FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role','vitana_governance_owner'));
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = 'authenticator') THEN
    RAISE EXCEPTION 'refused: authenticator already has role memberships; stop and report';
  END IF;
END $$;
SELECT 'precheck', 'ok (nothing the restore creates exists yet)';
