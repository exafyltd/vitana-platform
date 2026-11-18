-- precheck-sparring.sql — read-only. Run by restore-sparring-schema.sh before every apply (and in its dry run),
-- and by rehearse-restore.sh. Prints the facts Dragan is asked to confirm; raises (refuses) when the restore cannot
-- succeed or would touch a non-empty database.
\set ON_ERROR_STOP 1
SELECT 'database', current_database();
SELECT 'connected_as', current_user;
SELECT 'master_attributes', format('super=%s createrole=%s createdb=%s bypassrls=%s', rolsuper, rolcreaterole, rolcreatedb, rolbypassrls)
  FROM pg_roles WHERE rolname = current_user;
SELECT 'public_tables', count(*) FROM pg_tables WHERE schemaname = 'public';
SELECT 'role_' || r.n, CASE WHEN p.oid IS NULL THEN 'absent (will be created)'
                            ELSE 'present; master admin_option=' || coalesce((SELECT bool_or(m.admin_option)::text FROM pg_auth_members m
                                  JOIN pg_roles me ON me.oid = m.member WHERE m.roleid = p.oid AND me.rolname = current_user), 'false') END
  FROM (VALUES ('anon'), ('authenticated'), ('service_role'), ('vitana_governance_owner'), ('authenticator')) r(n)
  LEFT JOIN pg_roles p ON p.rolname = r.n ORDER BY 1;
DO $$
DECLARE r text; oid_ oid; adm bool;
BEGIN
  IF current_database() <> 'vitana' THEN RAISE EXCEPTION 'refused: database is %, expected vitana', current_database(); END IF;
  IF (SELECT count(*) FROM pg_tables WHERE schemaname = 'public') <> 0 THEN
    RAISE EXCEPTION 'refused: public schema is not empty; this restore only runs on the empty staging database';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    RAISE EXCEPTION 'refused: role authenticator (PostgREST login) does not exist';
  END IF;
  IF NOT (SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'refused: % has no CREATEROLE (use the cluster master user)', current_user;
  END IF;
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    SELECT oid INTO oid_ FROM pg_roles WHERE rolname = r;
    IF oid_ IS NOT NULL THEN
      SELECT bool_or(m.admin_option) INTO adm FROM pg_auth_members m JOIN pg_roles me ON me.oid = m.member
       WHERE m.roleid = oid_ AND me.rolname = current_user;
      IF NOT coalesce(adm, false) THEN
        RAISE EXCEPTION 'refused: role % already exists and % cannot grant it to authenticator (no ADMIN OPTION)', r, current_user;
      END IF;
    END IF;
  END LOOP;
END $$;
SELECT 'precheck', 'ok';
