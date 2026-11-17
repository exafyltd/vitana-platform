-- Preservation metrics, run identically on production (source, read-only) and staging (target).
-- Output is name|value. Counts and md5 digests only: no row content, no password hashes.
-- STAGING-ONLY OBJECTS (exact allowlist, created by aurora-cutover-outbox.sql; they do not exist in production and are the
-- only objects excluded from the comparison): relations outbound_http_requests, outbound_http_requests_pkey,
-- outbound_http_requests_due_idx, outbound_http_requests_id_seq; functions outbound_http_claim, outbound_http_complete,
-- outbound_http_fail. Nothing that exists in production is excluded. The two notify_* definitions exist in production and
-- are compared by fn_def lines; their staging replacement is the single permitted difference (see restore-core.sh step 9).
\pset tuples_only on
\pset format unaligned
\pset fieldsep '|'
WITH ns AS (SELECT oid FROM pg_namespace WHERE nspname IN ('public','governance','legacy_archive')),
rels AS (SELECT c.* FROM pg_class c WHERE c.relnamespace IN (SELECT oid FROM ns)
         AND c.relname NOT IN ('outbound_http_requests','outbound_http_requests_pkey','outbound_http_requests_due_idx','outbound_http_requests_id_seq')),
fns AS (SELECT p.* FROM pg_proc p WHERE p.pronamespace IN (SELECT oid FROM ns) AND p.prokind IN ('f','p')
        AND p.proname NOT IN ('outbound_http_claim','outbound_http_complete','outbound_http_fail'))
SELECT 'tables', count(*)::text FROM rels WHERE relkind IN ('r','p') AND NOT relispartition
UNION ALL SELECT 'partitions', count(*)::text FROM rels WHERE relkind IN ('r','p') AND relispartition
UNION ALL SELECT 'views', count(*)::text FROM rels WHERE relkind = 'v'
UNION ALL SELECT 'matviews', count(*)::text FROM rels WHERE relkind = 'm'
UNION ALL SELECT 'sequences', count(*)::text FROM rels WHERE relkind = 'S'
UNION ALL SELECT 'indexes', count(*)::text FROM rels WHERE relkind IN ('i','I')
UNION ALL SELECT 'enums', count(*)::text FROM pg_type WHERE typnamespace IN (SELECT oid FROM ns) AND typtype = 'e'
UNION ALL SELECT 'functions', count(*)::text FROM fns
UNION ALL SELECT 'function_names_md5', coalesce(md5(string_agg(proname || '(' || pg_get_function_identity_arguments(oid) || ')', E'\n' ORDER BY proname, pg_get_function_identity_arguments(oid))), 'none') FROM fns
UNION ALL SELECT 'triggers', count(*)::text FROM pg_trigger t JOIN rels c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal
UNION ALL SELECT 'policies', count(*)::text FROM pg_policy pol JOIN rels c ON c.oid = pol.polrelid
UNION ALL SELECT 'rls_enabled_tables', count(*)::text FROM rels WHERE relrowsecurity
UNION ALL SELECT 'fk_constraints', count(*)::text FROM pg_constraint WHERE connamespace IN (SELECT oid FROM ns) AND contype = 'f'
UNION ALL SELECT 'fk_to_auth_users', count(*)::text FROM pg_constraint WHERE contype = 'f' AND confrelid = to_regclass('auth.users')
UNION ALL SELECT 'acl_entries', count(*)::text FROM rels c, aclexplode(c.relacl) a WHERE c.relkind IN ('r','p','v','m','S')
UNION ALL SELECT 'md5_acl', coalesce(md5(string_agg(c.relname || ':' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type, E'\n' ORDER BY c.relname, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, a.privilege_type)), 'none') FROM rels c, aclexplode(c.relacl) a WHERE c.relkind IN ('r','p','v','m','S')
UNION ALL SELECT 'auth_users_triggers', count(*)::text FROM pg_trigger WHERE tgrelid = to_regclass('auth.users') AND NOT tgisinternal
UNION ALL SELECT 'auth_users_rls', count(*)::text FROM pg_class WHERE oid = to_regclass('auth.users') AND relrowsecurity
UNION ALL SELECT 'auth_users_rows', (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM auth.users', false, true, '')))[1]::text
UNION ALL SELECT 'auth_users_pk', count(*)::text FROM pg_constraint WHERE conrelid = to_regclass('auth.users') AND contype = 'p'
UNION ALL SELECT 'md5_triggers', coalesce(md5(string_agg(pg_get_triggerdef(t.oid), E'\n' ORDER BY pg_get_triggerdef(t.oid))), 'none') FROM pg_trigger t JOIN rels c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal
UNION ALL SELECT 'md5_policies', coalesce(md5(string_agg(concat_ws('|', tablename, policyname, cmd, roles::text, coalesce(qual,''), coalesce(with_check,'')), E'\n' ORDER BY tablename, policyname)), 'none') FROM pg_policies WHERE schemaname IN ('public','governance','legacy_archive') AND tablename NOT IN ('outbound_http_requests')
UNION ALL SELECT 'md5_foreign_keys', coalesce(md5(string_agg(pg_get_constraintdef(oid), E'\n' ORDER BY pg_get_constraintdef(oid))), 'none') FROM pg_constraint WHERE connamespace IN (SELECT oid FROM ns) AND contype = 'f'
UNION ALL SELECT 'fn_def:' || proname || '(' || pg_get_function_identity_arguments(oid) || ')', md5(pg_get_functiondef(oid)) FROM fns
ORDER BY 1;
