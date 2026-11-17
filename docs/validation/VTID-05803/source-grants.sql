-- VTID-05803: emit the live Supabase grants for the API roles (anon, authenticated, service_role, PUBLIC) as SQL.
-- Read-only on the source. The output is applied to Aurora staging after the schema-only restore, which runs with
-- --no-privileges because Supabase ACLs also name roles Aurora does not have (postgres, supabase_admin, ...).
-- Run: psql "$SOURCE_DATABASE_URL" -X -A -t -f source-grants.sql > grants.sql
\set ON_ERROR_STOP 1
SET default_transaction_read_only = on;

SELECT 'GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;';

-- tables, views, matviews, sequences, foreign tables
WITH acl AS (
  SELECT c.oid, c.relname, c.relkind,
         CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE r.rolname END AS grantee, x.privilege_type
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) x
  LEFT JOIN pg_roles r ON r.oid = x.grantee
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
)
SELECT format('GRANT %s ON %s public.%I TO %s;',
              string_agg(privilege_type, ', ' ORDER BY privilege_type),
              CASE WHEN relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
              relname,
              CASE WHEN grantee = 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(grantee) END)
FROM acl
WHERE grantee IN ('PUBLIC', 'anon', 'authenticated', 'service_role')
GROUP BY relname, relkind, grantee
ORDER BY relname, grantee;

-- functions: Postgres grants EXECUTE to PUBLIC by default; Supabase revokes it on some.
-- Revoke everything from the API roles first, then grant exactly what the source has.
SELECT format('REVOKE ALL ON ROUTINE public.%I(%s) FROM PUBLIC, anon, authenticated, service_role;',
              p.proname, pg_get_function_identity_arguments(p.oid))
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p', 'w')
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
ORDER BY 1;

SELECT format('GRANT EXECUTE ON ROUTINE public.%I(%s) TO %s;',
              p.proname, pg_get_function_identity_arguments(p.oid),
              CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(r.rolname) END)
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
LEFT JOIN pg_roles r ON r.oid = x.grantee
WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p', 'w')
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  AND (x.grantee = 0 OR r.rolname IN ('anon', 'authenticated', 'service_role'))
ORDER BY 1;
