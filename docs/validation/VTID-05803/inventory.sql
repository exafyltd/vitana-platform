-- VTID-05803 schema inventory (catalog metadata only, no table rows). Read-only.
-- Run the same file on the source (Supabase) and on Aurora staging, then diff the outputs:
--   psql "$URL" -X -A -t -F '|' -f inventory.sql | LC_ALL=C sort > side.inv
-- One line per object: kind|identity|definition-or-hash. Bodies are hashed so diffs stay short.
\set ON_ERROR_STOP 1
SET default_transaction_read_only = on;
SET search_path = pg_catalog;

-- extensions (all schemas)
SELECT 'extension', e.extname, n.nspname || ' ' || e.extversion
FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace;

-- relations in public: table, partitioned table, view, matview, sequence, foreign table
SELECT 'relation', c.relname, c.relkind::text || CASE WHEN c.relkind IN ('r','p') THEN ' rls=' || c.relrowsecurity::text || ' force=' || c.relforcerowsecurity::text ELSE '' END
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f')
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e');

-- columns: type, nullability, default
SELECT 'column', c.relname || '.' || a.attname,
       format_type(a.atttypid, a.atttypmod) || ' notnull=' || a.attnotnull::text
       || ' default=' || coalesce(pg_get_expr(ad.adbin, ad.adrelid), '') || ' gen=' || a.attgenerated::text
       || ' ident=' || a.attidentity::text
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f') AND a.attnum > 0 AND NOT a.attisdropped;

-- constraints (pk, unique, check, fk, exclusion)
SELECT 'constraint', c.relname || '.' || k.conname, k.contype::text || ' ' || pg_get_constraintdef(k.oid)
FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public';

-- indexes
SELECT 'index', i.indexname, md5(i.indexdef) FROM pg_indexes i WHERE i.schemaname = 'public';

-- sequences
SELECT 'sequence', s.sequencename, s.data_type::text || ' inc=' || s.increment_by || ' min=' || s.min_value || ' max=' || s.max_value || ' cycle=' || s.cycle::text
FROM pg_sequences s WHERE s.schemaname = 'public';

-- view and matview definitions (hashed)
SELECT 'viewdef', c.relname, md5(pg_get_viewdef(c.oid, true))
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('v','m');

-- functions and procedures (hashed body + config)
SELECT 'function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
       p.prokind::text || ' ' || l.lanname || ' secdef=' || p.prosecdef::text || ' ret=' || pg_get_function_result(p.oid)
       || ' cfg=' || coalesce(array_to_string(p.proconfig, ','), '') || ' body=' || md5(coalesce(p.prosrc, ''))
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
WHERE n.nspname = 'public'
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e');

-- triggers (non-internal)
SELECT 'trigger', c.relname || '.' || t.tgname, md5(pg_get_triggerdef(t.oid)) || ' enabled=' || t.tgenabled::text
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND NOT t.tgisinternal;

-- RLS policies
SELECT 'policy', p.tablename || '.' || p.policyname,
       p.permissive || ' ' || p.cmd || ' roles=' || array_to_string(p.roles, ',')
       || ' qual=' || md5(coalesce(p.qual, '')) || ' check=' || md5(coalesce(p.with_check, ''))
FROM pg_policies p WHERE p.schemaname = 'public';

-- table/view/sequence grants to the API roles (the only grantees carried to Aurora)
SELECT 'grant', c.relname || '>' || acl.grantee_name, string_agg(acl.privilege_type, ',' ORDER BY acl.privilege_type)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL (
  SELECT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE r.rolname END AS grantee_name, x.privilege_type
  FROM aclexplode(c.relacl) x LEFT JOIN pg_roles r ON r.oid = x.grantee
) acl
WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f')
  AND acl.grantee_name IN ('PUBLIC', 'anon', 'authenticated', 'service_role')
GROUP BY c.relname, acl.grantee_name;

-- function execute grants to the API roles
SELECT 'fgrant', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')>' || acl.grantee_name, 'EXECUTE'
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN LATERAL (
  SELECT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE r.rolname END AS grantee_name
  FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x LEFT JOIN pg_roles r ON r.oid = x.grantee
) acl
WHERE n.nspname = 'public' AND acl.grantee_name IN ('PUBLIC', 'anon', 'authenticated', 'service_role')
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e');

-- enum and composite/domain types in public
SELECT 'type', t.typname, t.typtype::text || ' ' || coalesce((SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid), '')
FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public' AND t.typtype IN ('e','d','c')
  AND (t.typtype <> 'c' OR EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c'));

-- storage-related schema objects visible on each side (Supabase keeps storage; Aurora should show none)
SELECT 'storage_relation', c.relname, c.relkind::text
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'storage' AND c.relkind IN ('r','v','m');
