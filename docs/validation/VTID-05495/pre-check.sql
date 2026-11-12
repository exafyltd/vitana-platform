-- VTID-05495 pre-apply check. Read-only. Expect: tenants_key_present = true, table_exists = false.
SELECT
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name = 'tenant_id') AS tenants_key_present,
  to_regclass('public.tenant_content_overrides') IS NOT NULL AS table_exists;
