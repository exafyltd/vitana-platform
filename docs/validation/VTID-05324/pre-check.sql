-- VTID-05324 read-only pre-check (before row 9 of docs/multitenancy/MIGRATION-QUEUE.md).
-- Expect: both tables and the function absent, tenants(tenant_id) present, maxina present.
SELECT
  to_regclass('public.tenant_pack_intake')      IS NULL AS pack_intake_absent,
  to_regclass('public.tenant_content_pipeline') IS NULL AS content_pipeline_absent,
  to_regprocedure('public.get_tenant_launch_readiness(uuid)') IS NULL AS readiness_fn_absent,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name = 'tenant_id') AS tenants_key_present,
  EXISTS (SELECT 1 FROM public.tenants WHERE slug = 'maxina') AS maxina_present;
