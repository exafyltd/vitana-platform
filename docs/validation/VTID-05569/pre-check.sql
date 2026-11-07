-- VTID-05569 pre-check (READ-ONLY). Run before 20261102043000_vtid_05569_hot_tables_tenant_not_null_assert.sql.
-- Expected: nullable = 'NO' and orphan_rows = 0 on every row. A row that differs means the assertion would RAISE: stop and
-- re-plan the expand/contract, do not apply. Kiro never runs this against a live system; RUN-MIGRATION's read-only check does.
WITH tenant_ids AS (
  SELECT tenant_id AS id FROM public.tenants
  UNION
  SELECT id FROM public.tenants
)
SELECT c.table_name,
       c.is_nullable AS nullable,
       CASE c.table_name
         WHEN 'chat_messages'             THEN (SELECT count(*) FROM public.chat_messages x             WHERE NOT EXISTS (SELECT 1 FROM tenant_ids t WHERE t.id = x.tenant_id))
         WHEN 'user_notifications'        THEN (SELECT count(*) FROM public.user_notifications x        WHERE NOT EXISTS (SELECT 1 FROM tenant_ids t WHERE t.id = x.tenant_id))
         WHEN 'product_analytics_events'  THEN (SELECT count(*) FROM public.product_analytics_events x  WHERE NOT EXISTS (SELECT 1 FROM tenant_ids t WHERE t.id = x.tenant_id))
       END AS orphan_rows
  FROM information_schema.columns c
 WHERE c.table_schema = 'public'
   AND c.table_name IN ('chat_messages', 'user_notifications', 'product_analytics_events')
   AND c.column_name = 'tenant_id'
 ORDER BY c.table_name;
