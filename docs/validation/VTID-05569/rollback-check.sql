-- VTID-05569 rollback-check (READ-ONLY). Run after 20261102043100_vtid_05569_hot_tables_tenant_not_null_assert_rollback.sql.
-- The rollback is a no-op, so the state must be exactly what post-check.sql reports: the three tenant_id columns are still
-- NOT NULL (a rollback of this lane must never drop them) and nothing named *05569* exists.
SELECT
  (SELECT count(*) = 3 AND bool_and(is_nullable = 'NO')
     FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'tenant_id'
      AND table_name IN ('chat_messages', 'user_notifications', 'product_analytics_events')) AS still_not_null,
  NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname LIKE '%05569%') AS nothing_left_behind;
