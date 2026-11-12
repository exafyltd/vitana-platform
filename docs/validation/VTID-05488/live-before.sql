-- VTID-05488 live-before: READ-ONLY. Run by Kiro through RUN-MIGRATION's read-only check BEFORE the first lane
-- migration (20261102120000). SELECT statements only; nothing here writes. Compare with post-apply-checks.sql.

-- 1. The objects the lane creates must not exist yet (an already-applied lane would show here).
SELECT to_regclass('public.supplier_tenant_relationships') AS supplier_tenant_relationships,
       to_regprocedure('public.discover_tenant_gate_enabled()') AS discover_tenant_gate_enabled,
       to_regclass('public.bak_vtid_05488_partner_tenant') AS partner_tenant_snapshot,
       (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'distribution') AS products_distribution_col,
       (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'partner_tenant' AND column_name = 'tenant_uuid') AS partner_tenant_uuid_col;

-- 2. The tenants key the migrations reference (live is tenants.tenant_id; the migrations accept tenant_id or id) and Maxina.
SELECT column_name FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name IN ('tenant_id', 'id') ORDER BY column_name;
SELECT slug, is_default FROM public.tenants ORDER BY slug;

-- 3. Everything the migrations depend on.
SELECT to_regclass('public.merchants') AS merchants, to_regclass('public.products') AS products,
       to_regclass('public.user_tenants') AS user_tenants, to_regclass('public.tenant_settings') AS tenant_settings,
       to_regprocedure('public.current_tenant_id()') AS current_tenant_id,
       to_regclass('public.partner_tenant') AS partner_tenant, to_regclass('public.partner_organizations') AS partner_organizations;

-- 4. Baselines: what the seed and the policy will act on. products_active/merchants_active are the counts every
--    authenticated session sees today (is_active only); with the gate off they must stay equal after the apply.
SELECT (SELECT count(*) FROM public.merchants) AS merchants_total,
       (SELECT count(*) FROM public.merchants WHERE is_active) AS merchants_active,
       (SELECT count(*) FROM public.products) AS products_total,
       (SELECT count(*) FROM public.products WHERE is_active) AS products_active;

-- 5. The current policies (expect is_active = TRUE only) and tenant gate flags (expect none set).
SELECT tablename, policyname, cmd, roles, qual FROM pg_policies
 WHERE schemaname = 'public' AND tablename IN ('products', 'merchants') ORDER BY tablename, policyname;
SELECT count(*) AS tenants_with_gate_on FROM public.tenant_settings
 WHERE feature_flags -> 'mt' ->> 'discover_tenant_gate' = 'true';

-- 6. partner_tenant: column type and the free-text values the backfill will try to resolve.
SELECT data_type FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'partner_tenant' AND column_name = 'tenant_id';
SELECT tenant_id, count(*) FROM public.partner_tenant GROUP BY tenant_id ORDER BY count(*) DESC LIMIT 50;

-- 7. partner_tenant keys that collide with a tenant slug (the 120200 backfill maps these to that tenant). Read-only;
--    eyeball every row before apply. The mapping is reversible (snapshot + dropped tenant_uuid column).
SELECT p.tenant_id AS partner_key, t.slug, t.tenant_id AS mapped_tenant_uuid, count(*) AS partner_rows
  FROM public.partner_tenant p
  JOIN public.tenants t ON t.slug = p.tenant_id
 GROUP BY p.tenant_id, t.slug, t.tenant_id ORDER BY count(*) DESC;
