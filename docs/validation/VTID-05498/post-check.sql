-- VTID-05498 post-apply check. Read-only. Expect every column true.
SELECT
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'knowledge_docs' AND column_name = 'tenant_id'
             AND data_type = 'uuid' AND is_nullable = 'YES' AND column_default IS NULL) AS column_present_nullable,
  EXISTS (SELECT 1 FROM pg_constraint
           WHERE conrelid = to_regclass('public.knowledge_docs') AND contype = 'f'
             AND confrelid = to_regclass('public.tenants')) AS fk_to_tenants,
  (SELECT count(*) FROM public.knowledge_docs WHERE tenant_id IS NOT NULL) = 0 AS all_rows_null;
