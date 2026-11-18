-- VTID-05488 rollback-check: READ-ONLY. After the four rollback files ran (reverse order). SELECT only.
-- Expect: supplier_tenant_relationships NULL, helper NULL, distribution_col 0, tenant_uuid_col 0,
-- both policies is_active-only and free of discover_tenant_gate_enabled. The snapshot table may remain.
SELECT to_regclass('public.supplier_tenant_relationships') AS supplier_tenant_relationships,
       to_regprocedure('public.discover_tenant_gate_enabled()') AS helper,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'distribution') AS distribution_col,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'partner_tenant' AND column_name = 'tenant_uuid') AS tenant_uuid_col;
SELECT tablename, policyname, qual FROM pg_policies
 WHERE schemaname = 'public' AND tablename IN ('products', 'merchants') AND policyname IN ('products_select', 'merchants_select');
