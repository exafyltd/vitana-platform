-- VTID-05488 post-apply-checks: READ-ONLY. Run by Kiro through RUN-MIGRATION's read-only check AFTER the four lane
-- migrations (20261102120000..120300). SELECT statements only. Each check names its expected result.

-- 1. [after 120000] table, RLS, policies, privileges. Expect: rls true; policies member_select + service; authenticated SELECT only.
SELECT c.relrowsecurity AS rls_on FROM pg_class c WHERE c.oid = 'public.supplier_tenant_relationships'::regclass;
SELECT policyname, cmd, roles FROM pg_policies WHERE schemaname = 'public' AND tablename = 'supplier_tenant_relationships' ORDER BY policyname;
SELECT has_table_privilege('authenticated', 'public.supplier_tenant_relationships', 'SELECT') AS auth_select,
       has_table_privilege('authenticated', 'public.supplier_tenant_relationships', 'INSERT') AS auth_insert,
       has_table_privilege('anon', 'public.supplier_tenant_relationships', 'SELECT') AS anon_select,
       has_table_privilege('service_role', 'public.supplier_tenant_relationships', 'INSERT') AS service_insert;
-- Expect: auth_select true, auth_insert false, anon_select false, service_insert true.

-- 2. [after 120000] seed: Maxina only. Expect: tenants_seeded = 1 (maxina), rows = merchants_total from live-before.sql, all active.
SELECT count(DISTINCT r.tenant_id) AS tenants_seeded, count(*) AS rows, count(*) FILTER (WHERE r.status = 'active') AS active_rows,
       (SELECT count(*) FROM public.merchants) AS merchants_total,
       bool_and(r.tenant_id = (SELECT t.tenant_id FROM public.tenants t WHERE t.slug = 'maxina')) AS only_maxina
  FROM public.supplier_tenant_relationships r;

-- 3. [after 120100] distribution. Expect: column present, NOT NULL, default 'community'; non_community = 0.
SELECT is_nullable, column_default FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'distribution';
SELECT count(*) FILTER (WHERE distribution <> 'community') AS non_community, count(*) AS products_total FROM public.products;
SELECT convalidated FROM pg_constraint WHERE conname = 'products_distribution_check' AND conrelid = 'public.products'::regclass;
--   Expect false: 120100 deliberately leaves the CHECK NOT VALID (no scan under ACCESS EXCLUSIVE). A later
--   VALIDATE CONSTRAINT in its own transaction flips it to true; that is optional.

-- 4. [after 120200] partner_tenant. Expect: snapshot rows = partner_tenant rows before; tenant_id still text;
--    mapped + unresolved = total. A table that does not exist yields NULL here and no 120200 objects.
SELECT to_regclass('public.bak_vtid_05488_partner_tenant') AS snapshot;
SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'partner_tenant' AND column_name = 'tenant_id';  -- text
SELECT count(*) AS total, count(*) FILTER (WHERE tenant_uuid IS NOT NULL) AS mapped, count(*) FILTER (WHERE tenant_uuid IS NULL) AS unresolved
  FROM public.partner_tenant;
SELECT p.id, p.tenant_id AS free_text, p.tenant_uuid, t.slug FROM public.partner_tenant p
  LEFT JOIN public.tenants t ON t.tenant_id = p.tenant_uuid ORDER BY p.id LIMIT 100;  -- eyeball every mapping

-- 5. [after 120300] helper and policies. Expect: helper SECURITY DEFINER, STABLE, search_path public, pg_catalog,
--    EXECUTE for authenticated and service_role only; both policies mention discover_tenant_gate_enabled.
SELECT prosecdef, provolatile, proconfig FROM pg_proc WHERE oid = 'public.discover_tenant_gate_enabled()'::regprocedure;
SELECT has_function_privilege('authenticated', 'public.discover_tenant_gate_enabled()', 'EXECUTE') AS auth_exec,
       has_function_privilege('anon', 'public.discover_tenant_gate_enabled()', 'EXECUTE') AS anon_exec;  -- true / false
SELECT tablename, policyname, qual ~ 'discover_tenant_gate_enabled' AS gate_guarded,
       (qual ~ 'is_member|tenant_id_for_policies') AS uses_forbidden_helper   -- expect true / false
  FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('products', 'merchants') AND policyname IN ('products_select', 'merchants_select');

-- 6. Gate off => unchanged. With zero tenants having the gate on (live-before.sql check 5) the policy equals is_active only,
--    so the counts every authenticated session sees must equal live-before.sql check 4 (products_active / merchants_active).
SELECT count(*) AS tenants_with_gate_on FROM public.tenant_settings WHERE feature_flags -> 'mt' ->> 'discover_tenant_gate' = 'true';  -- 0
SELECT (SELECT count(*) FROM public.merchants WHERE is_active) AS merchants_active,
       (SELECT count(*) FROM public.products WHERE is_active) AS products_active;

-- 7. [after 120000] seed coverage. Expect seeded_active_rows = merchants_total (0 rows silently means the 'maxina' slug is absent).
--    Merchants created AFTER the seed need an active supplier_tenant_relationships row before any tenant enables
--    mt.discover_tenant_gate (rollout checklist), otherwise they are hidden from that tenant.
SELECT (SELECT count(*) FROM public.merchants) AS merchants_total,
       (SELECT count(*) FROM public.supplier_tenant_relationships r JOIN public.tenants t ON t.tenant_id = r.tenant_id
         WHERE t.slug = 'maxina' AND r.status = 'active') AS seeded_active_rows,
       (SELECT count(*) FROM public.merchants m
         WHERE NOT EXISTS (SELECT 1 FROM public.supplier_tenant_relationships r JOIN public.tenants t ON t.tenant_id = r.tenant_id
                            WHERE t.slug = 'maxina' AND r.status = 'active' AND r.merchant_id = m.id)) AS merchants_without_maxina_row;  -- 0
