-- VTID-05498 pre-apply check. Read-only. Expect: knowledge_docs_exists = true, tenants_key_present = true, column_exists = false.
SELECT
  to_regclass('public.knowledge_docs') IS NOT NULL AS knowledge_docs_exists,
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name = 'tenant_id') AS tenants_key_present,
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'knowledge_docs' AND column_name = 'tenant_id') AS column_exists;
