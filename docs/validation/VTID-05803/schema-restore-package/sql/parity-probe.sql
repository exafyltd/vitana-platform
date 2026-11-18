-- Read-only parity metrics, public schema. Same definitions as the source baseline. Counts only.
\pset tuples_only on
\pset format unaligned
\pset fieldsep '|'
WITH ns AS (SELECT oid FROM pg_namespace WHERE nspname='public')
SELECT 'tables', count(*) FROM pg_class WHERE relnamespace IN (SELECT oid FROM ns) AND relkind='r' AND NOT relispartition
UNION ALL SELECT 'partitions', count(*) FROM pg_class WHERE relnamespace IN (SELECT oid FROM ns) AND relkind IN ('r','p') AND relispartition
UNION ALL SELECT 'views', count(*) FROM pg_class WHERE relnamespace IN (SELECT oid FROM ns) AND relkind='v'
UNION ALL SELECT 'matviews', count(*) FROM pg_class WHERE relnamespace IN (SELECT oid FROM ns) AND relkind='m'
UNION ALL SELECT 'sequences', count(*) FROM pg_class WHERE relnamespace IN (SELECT oid FROM ns) AND relkind='S'
UNION ALL SELECT 'indexes', count(*) FROM pg_class WHERE relnamespace IN (SELECT oid FROM ns) AND relkind IN ('i','I')
UNION ALL SELECT 'functions', count(*) FROM pg_proc WHERE pronamespace IN (SELECT oid FROM ns) AND prokind IN ('f','p')
UNION ALL SELECT 'triggers', count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace IN (SELECT oid FROM ns) AND NOT t.tgisinternal
UNION ALL SELECT 'policies', count(*) FROM pg_policies WHERE schemaname='public'
UNION ALL SELECT 'rls_enabled_tables', count(*) FROM pg_class WHERE relnamespace IN (SELECT oid FROM ns) AND relkind IN ('r','p') AND relrowsecurity
UNION ALL SELECT 'fk_constraints', count(*) FROM pg_constraint WHERE connamespace IN (SELECT oid FROM ns) AND contype='f'
UNION ALL SELECT 'fk_to_auth', count(*) FROM pg_constraint WHERE contype='f' AND confrelid=to_regclass('auth.users')
UNION ALL SELECT 'fk_public_to_auth', count(*) FROM pg_constraint WHERE connamespace IN (SELECT oid FROM ns) AND contype='f' AND confrelid=to_regclass('auth.users')
UNION ALL SELECT 'enums', count(*) FROM pg_type WHERE typnamespace IN (SELECT oid FROM ns) AND typtype='e'
UNION ALL SELECT 'acl_entries', count(*) FROM pg_class c, aclexplode(c.relacl) a WHERE c.relnamespace IN (SELECT oid FROM ns) AND c.relkind IN ('r','p','v','m','S')
UNION ALL SELECT 'acl_api_entries', count(*) FROM pg_class c, aclexplode(c.relacl) a WHERE c.relnamespace IN (SELECT oid FROM ns) AND c.relkind IN ('r','p','v','m','S') AND (a.grantee = 0 OR a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')))
UNION ALL SELECT 'public_rows_estimate', coalesce(sum(n_live_tup),0) FROM pg_stat_user_tables WHERE schemaname='public'
ORDER BY 1;
