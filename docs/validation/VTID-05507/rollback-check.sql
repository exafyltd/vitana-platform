-- VTID-05507 rollback-check: READ-ONLY. After the two rollback files ran (rollback-140100 first, then rollback-140000).
-- Expect: tenant_domains NULL, trigger_fn NULL, two_arg NULL, one_arg present, same one_arg_body_md5 as live-before.sql.
SELECT to_regclass('public.tenant_domains') AS tenant_domains,
       to_regprocedure('public.tenant_domains_reject_reserved()') AS trigger_fn,
       to_regprocedure('public.resolve_tenant(text, text)') AS two_arg,
       to_regprocedure('public.resolve_tenant(text)') AS one_arg;
SELECT md5(p.prosrc) AS one_arg_body_md5 FROM pg_proc p WHERE p.oid = to_regprocedure('public.resolve_tenant(text)');
