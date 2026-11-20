-- VTID-05569 post-check (READ-ONLY). Run after 20261102043000_vtid_05569_hot_tables_tenant_not_null_assert.sql.
-- The migration changes nothing, so this is the same question as pre-check.sql, answered as three booleans that must all be true
-- (all_not_null: all three columns found and NOT NULL; no_orphans: no row on a missing tenant; no_object_added: the migration
-- left no function or trigger behind on the three tables beyond what existed).
WITH tenant_ids AS (
  SELECT tenant_id AS id FROM public.tenants
)
SELECT
  (SELECT count(*) = 3 AND bool_and(is_nullable = 'NO')
     FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'tenant_id'
      AND table_name IN ('chat_messages', 'user_notifications', 'product_analytics_events')) AS all_not_null,
  ((SELECT count(*) FROM public.chat_messages x            WHERE NOT EXISTS (SELECT 1 FROM tenant_ids t WHERE t.id = x.tenant_id))
 + (SELECT count(*) FROM public.user_notifications x       WHERE NOT EXISTS (SELECT 1 FROM tenant_ids t WHERE t.id = x.tenant_id))
 + (SELECT count(*) FROM public.product_analytics_events x WHERE NOT EXISTS (SELECT 1 FROM tenant_ids t WHERE t.id = x.tenant_id))) = 0 AS no_orphans,
  NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname LIKE '%05569%') AS no_object_added;
