-- precheck-sparring.sql — READ-ONLY. Runs first in restore-sparring-schema.sh (dry run and --apply) and in
-- rehearse-restore.sh. Prints what can be verified before the restore and refuses when the restore could fail or
-- touch anything it cannot exactly undo.
-- v2 (after the 2026-11-18 live dry run): the PostgREST request roles anon / authenticated / service_role may already
-- exist (Aurora staging has them, granted to authenticator). They are then kept: never dropped, and memberships /
-- schema grants that existed before are never revoked (prestate-sparring.sql records them; --rollback replays it).
\set ON_ERROR_STOP 1
SELECT 'server_version', current_setting('server_version');
SELECT 'database', current_database();
SELECT 'connected_as', current_user;
SELECT 'master_attributes', format('superuser=%s createrole=%s createdb=%s bypassrls=%s', rolsuper, rolcreaterole, rolcreatedb, rolbypassrls)
  FROM pg_roles WHERE rolname = current_user;
SELECT 'master_member_of', coalesce(string_agg(r.rolname || CASE WHEN m.admin_option THEN '(admin)' ELSE '' END, ',' ORDER BY r.rolname), '(none)')
  FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles me ON me.oid = m.member WHERE me.rolname = current_user;
SELECT 'database_owner', pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database();
SELECT 'can_create_in_schema_public', has_schema_privilege(current_user, 'public', 'CREATE');
SELECT 'public_schema_acl', coalesce(nspacl::text, '(default)') FROM pg_namespace WHERE nspname = 'public';
SELECT 'public_tables', count(*) FROM pg_tables WHERE schemaname = 'public';
SELECT 'public_functions', count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace;
SELECT 'public_sequences', count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'S';
SELECT 'role_' || r.n,
       CASE WHEN p.oid IS NULL THEN 'absent (restore creates it; rollback drops it)'
            ELSE format('PRESENT (kept) login=%s inherit=%s bypassrls=%s master_admin=%s public_usage_grant=%s owns_objects=%s',
                        p.rolcanlogin, p.rolinherit, p.rolbypassrls,
                        coalesce((SELECT bool_or(m.admin_option) FROM pg_auth_members m JOIN pg_roles me ON me.oid = m.member
                                   WHERE m.roleid = p.oid AND me.rolname = current_user), false),
                        EXISTS (SELECT 1 FROM pg_namespace ns CROSS JOIN LATERAL aclexplode(ns.nspacl) a
                                 WHERE ns.nspname = 'public' AND a.grantee = p.oid AND a.privilege_type = 'USAGE'),
                        EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner = p.oid)
                          OR EXISTS (SELECT 1 FROM pg_proc f WHERE f.proowner = p.oid)) END
  FROM (VALUES ('anon'), ('authenticated'), ('service_role'), ('vitana_governance_owner')) r(n)
  LEFT JOIN pg_roles p ON p.rolname = r.n ORDER BY 1;
SELECT 'authenticator', CASE WHEN p.oid IS NULL THEN 'ABSENT' ELSE format('login=%s inherit=%s superuser=%s bypassrls=%s', p.rolcanlogin, p.rolinherit, p.rolsuper, p.rolbypassrls) END
  FROM (VALUES ('authenticator')) r(n) LEFT JOIN pg_roles p ON p.rolname = r.n;
SELECT 'authenticator_member_of', coalesce(string_agg(r.rolname, ',' ORDER BY r.rolname), '(none)')
  FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = 'authenticator';
SELECT 'schemas_auth_storage_extensions', coalesce(string_agg(nspname, ',' ORDER BY nspname), '(none)')
  FROM pg_namespace WHERE nspname IN ('auth', 'storage', 'extensions');
\echo 'prestate (created_roles|revoke_memberships|revoke_usage):'
\ir prestate-sparring.sql
DO $$
DECLARE r text; oid_ oid; adm bool; member bool;
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
  -- No restore OBJECT may exist yet: every table, function and sequence --rollback drops was created by the restore.
  IF (SELECT count(*) FROM pg_tables WHERE schemaname = 'public') <> 0 THEN
    RAISE EXCEPTION 'refused: public schema has tables; this restore only runs on the empty staging database';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace) THEN
    RAISE EXCEPTION 'refused: public schema has functions (%); stop and report', (SELECT string_agg(proname, ',') FROM pg_proc WHERE pronamespace = 'public'::regnamespace);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace) THEN
    RAISE EXCEPTION 'refused: public schema has relations (sequences/views); stop and report';
  END IF;
  -- The break-glass identity must be created by this restore (its policies and grants are part of the restore).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vitana_governance_owner') THEN
    RAISE EXCEPTION 'refused: role vitana_governance_owner already exists; stop and report';
  END IF;
  -- A request role that predates the restore is kept. If authenticator is not yet its member, the restore grants it,
  -- which needs ADMIN OPTION on that role.
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    SELECT oid INTO oid_ FROM pg_roles WHERE rolname = r;
    CONTINUE WHEN oid_ IS NULL;
    SELECT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles u ON u.oid = m.member WHERE m.roleid = oid_ AND u.rolname = 'authenticator') INTO member;
    SELECT coalesce(bool_or(m.admin_option), false) INTO adm FROM pg_auth_members m JOIN pg_roles me ON me.oid = m.member
     WHERE m.roleid = oid_ AND me.rolname = current_user;
    IF NOT member AND NOT adm THEN
      RAISE EXCEPTION 'refused: role % exists, authenticator is not its member, and % has no ADMIN OPTION to grant it', r, current_user;
    END IF;
  END LOOP;
END $$;
SELECT 'precheck', 'ok (no restore object exists; pre-existing request roles are kept and recorded)';
