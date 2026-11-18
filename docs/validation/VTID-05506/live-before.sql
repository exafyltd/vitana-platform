-- VTID-05506 live-before: READ-ONLY. Run by Kiro through RUN-MIGRATION's read-only check BEFORE the first lane
-- migration (20261102141000). SELECT statements only; nothing here writes. Compare with post-apply-checks.sql.

-- 1. The objects the lane creates must not exist yet. Expect: by_tenant NULL.
SELECT to_regprocedure('public.ci_tenant_isolation_health_by_tenant()') AS by_tenant;

-- 2. What the lane depends on. Expect: all three present.
SELECT to_regprocedure('public.provision_tenant(text,text,text,uuid,text,text,numeric,text,text[],text,text)') AS provision_tenant,
       to_regprocedure('public.tenant_settings_merge_feature_flags(uuid,jsonb,boolean,uuid)') AS merge_fn,
       to_regprocedure('public.ci_tenant_isolation_health()') AS ci_health;

-- 3. Baselines of the three functions, to compare after. Expect (before): no erp request in either body.
SELECT p.proname,
       md5(p.prosrc) AS body_md5,
       position('bootstrap_requested' IN p.prosrc) > 0 AS mentions_bootstrap_requested,
       position('''erp''' IN p.prosrc) > 0 AS mentions_erp
  FROM pg_proc p
 WHERE p.oid IN (to_regprocedure('public.provision_tenant(text,text,text,uuid,text,text,numeric,text,text[],text,text)'),
                 to_regprocedure('public.tenant_settings_merge_feature_flags(uuid,jsonb,boolean,uuid)'),
                 to_regprocedure('public.ci_tenant_isolation_health()'))
 ORDER BY p.proname;
-- Expect: mentions_* false for provision_tenant and the merge function; record the three md5 values.

-- 4. Tenants that already carry an erp key, and the single-number health, to compare after.
SELECT count(*) AS tenants_with_erp_key FROM public.tenant_settings WHERE feature_flags ? 'erp';   -- Expect 0 (nothing writes it yet).
SELECT public.ci_tenant_isolation_health() AS health;   -- record foreign_tenant_rows / null_tenant_rows / drift counts.
