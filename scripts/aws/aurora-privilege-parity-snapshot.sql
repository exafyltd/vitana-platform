-- Privilege-parity catalog snapshot (VTID-05023, part 0).
--
-- One read-only SELECT that returns one JSON document (column `snapshot`)
-- describing what the PostgREST-facing roles anon, authenticated and
-- service_role (and PUBLIC, which every role inherits) may do in schema
-- `public`. Run the SAME text on Supabase (read-only SQL) and on Aurora (the
-- parity script runs it through the RDS Data API) and feed both documents to
-- scripts/aws/aurora-privilege-parity.py.
--
-- Reads pg_catalog only (aclexplode over the raw ACLs, not
-- information_schema, which hides grants the caller is not involved in).
-- Works on PostgreSQL 13+; no writes, no temp objects, no settings changed.
--
-- Keys: table_grants, column_grants, routine_grants, rls, default_acl,
-- role_settings, role_attributes, role_memberships, roles, plus
-- snapshot_version, server_version_num, database. Every list is ordered so
-- the document is byte-identical across runs on an unchanged catalog (the
-- Data API path fetches it in chunks and checks the md5).
WITH api_roles(rolname) AS (
  VALUES ('anon'), ('authenticated'), ('service_role')
),
grantees AS (
  SELECT r.oid, r.rolname::text AS rolname
  FROM pg_roles r JOIN api_roles a ON a.rolname = r.rolname
  UNION ALL
  SELECT 0::oid, 'PUBLIC'
),
pub AS (
  SELECT oid FROM pg_namespace WHERE nspname = 'public'
),
ext_members AS (
  SELECT d.classid, d.objid, e.extname::text AS extname
  FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid
  WHERE d.refclassid = 'pg_extension'::regclass AND d.deptype = 'e'
),
rels AS (
  SELECT c.oid, c.relname::text AS relname, c.relkind::text AS relkind, c.relowner,
         c.relacl, c.relrowsecurity, c.relforcerowsecurity, em.extname
  FROM pg_class c
  JOIN pub ON c.relnamespace = pub.oid
  LEFT JOIN ext_members em ON em.classid = 'pg_class'::regclass AND em.objid = c.oid
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
),
table_grants AS (
  SELECT 'public'::text AS schema, r.relname AS "table", r.relkind, g.rolname AS grantee,
         a.privilege_type::text AS privilege, r.extname AS extension
  FROM rels r
  CROSS JOIN LATERAL aclexplode(COALESCE(r.relacl,
      acldefault((CASE WHEN r.relkind = 'S' THEN 's' ELSE 'r' END)::"char", r.relowner))) a
  JOIN grantees g ON g.oid = a.grantee
),
column_grants AS (
  SELECT 'public'::text AS schema, r.relname AS "table", att.attname::text AS "column",
         g.rolname AS grantee, a.privilege_type::text AS privilege, r.extname AS extension
  FROM rels r
  JOIN pg_attribute att ON att.attrelid = r.oid AND att.attnum > 0
       AND NOT att.attisdropped AND att.attacl IS NOT NULL
  CROSS JOIN LATERAL aclexplode(att.attacl) a
  JOIN grantees g ON g.oid = a.grantee
),
routine_grants AS (
  SELECT 'public'::text AS schema,
         p.proname::text || '(' || oidvectortypes(p.proargtypes) || ')' AS routine_signature,
         p.proname::text AS routine_name, oidvectortypes(p.proargtypes) AS routine_args,
         p.prokind::text AS prokind, g.rolname AS grantee,
         a.privilege_type::text AS privilege, em.extname AS extension
  FROM pg_proc p
  JOIN pub ON p.pronamespace = pub.oid
  LEFT JOIN ext_members em ON em.classid = 'pg_proc'::regclass AND em.objid = p.oid
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f'::"char", p.proowner))) a
  JOIN grantees g ON g.oid = a.grantee
),
rls AS (
  SELECT 'public'::text AS schema, r.relname AS "table", r.relrowsecurity AS rls_enabled,
         r.relforcerowsecurity AS rls_forced, r.extname AS extension
  FROM rels r
  WHERE r.relkind IN ('r', 'p')
),
default_acl AS (
  SELECT pg_get_userbyid(d.defaclrole)::text AS role, n.nspname::text AS schema,
         d.defaclobjtype::text AS objtype, g.rolname AS grantee,
         array_agg(a.privilege_type::text ORDER BY a.privilege_type::text) AS privileges
  FROM pg_default_acl d
  LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
  CROSS JOIN LATERAL aclexplode(d.defaclacl) a
  JOIN grantees g ON g.oid = a.grantee
  WHERE d.defaclnamespace = 0 OR n.nspname = 'public'
  GROUP BY 1, 2, 3, 4
),
role_settings AS (
  SELECT r.rolname::text AS role, s.setting, db.datname::text AS database
  FROM pg_db_role_setting rs
  JOIN pg_roles r ON r.oid = rs.setrole
  JOIN api_roles ar ON ar.rolname = r.rolname
  LEFT JOIN pg_database db ON db.oid = rs.setdatabase
  CROSS JOIN LATERAL unnest(rs.setconfig) s(setting)
  WHERE rs.setdatabase = 0 OR db.datname = current_database()
),
role_attributes AS (
  SELECT r.rolname::text AS role, r.rolsuper, r.rolbypassrls, r.rolinherit, r.rolcanlogin
  FROM pg_roles r JOIN api_roles ar ON ar.rolname = r.rolname
),
role_memberships AS (
  SELECT m.rolname::text AS role, g.rolname::text AS member_of
  FROM pg_auth_members am
  JOIN pg_roles m ON m.oid = am.member
  JOIN pg_roles g ON g.oid = am.roleid
  JOIN api_roles ar ON ar.rolname = m.rolname
)
SELECT json_build_object(
  'snapshot_version', 1,
  'server_version_num', current_setting('server_version_num')::int,
  'database', current_database(),
  'table_grants', COALESCE((SELECT json_agg(t ORDER BY t."table", t.grantee, t.privilege) FROM table_grants t), '[]'::json),
  'column_grants', COALESCE((SELECT json_agg(t ORDER BY t."table", t."column", t.grantee, t.privilege) FROM column_grants t), '[]'::json),
  'routine_grants', COALESCE((SELECT json_agg(t ORDER BY t.routine_signature, t.grantee, t.privilege) FROM routine_grants t), '[]'::json),
  'rls', COALESCE((SELECT json_agg(t ORDER BY t."table") FROM rls t), '[]'::json),
  'default_acl', COALESCE((SELECT json_agg(t ORDER BY t.role, t.schema NULLS FIRST, t.objtype, t.grantee) FROM default_acl t), '[]'::json),
  'role_settings', COALESCE((SELECT json_agg(t ORDER BY t.role, t.database NULLS FIRST, t.setting) FROM role_settings t), '[]'::json),
  'role_attributes', COALESCE((SELECT json_agg(t ORDER BY t.role) FROM role_attributes t), '[]'::json),
  'role_memberships', COALESCE((SELECT json_agg(t ORDER BY t.role, t.member_of) FROM role_memberships t), '[]'::json),
  'roles', COALESCE((SELECT json_agg(r.rolname::text ORDER BY r.rolname::text) FROM pg_roles r WHERE r.rolname !~ '^pg_'), '[]'::json)
)::text AS snapshot
