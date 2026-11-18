-- impact-allow-solo-migration: assertion only, no DDL and no data change; no gateway or worker code reads anything here.
-- VTID-05569 (mt-data-cleanup-r2 / hot-tables-not-null-expand-contract): assert and pin NOT NULL tenant_id on the hot tables.
--
-- Plan premise 5: chat_messages (20260225200000_chat_messages.sql:8), user_notifications (20260225000000_notification_system.sql:27)
-- and product_analytics_events (20260612140000_BOOTSTRAP_product_analytics_events.sql:33) are already `tenant_id ... NOT NULL`
-- in DDL, so there is nothing to expand or contract. This file changes no schema and no row: no trigger, no backfill, no
-- default, no SET NOT NULL. It is a read-only DO block that RAISEs (and so aborts the apply) when, at the time it runs:
--   * `tenant_id` on any of the three tables is nullable per information_schema (or the column or table is missing), or
--   * any row's `tenant_id` is not a tenant that exists (this includes the zero-orphan state that
--     VTID-05571 mt-data-cleanup-r2/orphan-analysis-and-quarantine and VTID-05572 profiles-tenant-backfill leave behind).
-- If it ever fires, stop: the real expand/contract (collab spec section 4.7) is re-planned in a new sparred plan, not improvised here.
-- Apply only through RUN-MIGRATION.yml after the owner approves the file and the target database (collaboration.md section 7d).
-- Rollback: 20261102043100_vtid_05569_hot_tables_tenant_not_null_assert_rollback.sql (a no-op; there is nothing to undo).

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

DO $assert$
DECLARE
  v_t        text;
  v_nullable text;
  v_cols     text[];
  v_tenants  text;
  v_orphans  bigint;
BEGIN
  -- Every tenant id that exists. Production carries tenants.tenant_id (most FKs) and the bootstrap id column; read both.
  SELECT array_agg(c.column_name::text ORDER BY c.column_name) INTO v_cols
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'tenants' AND c.column_name IN ('tenant_id', 'id');
  IF v_cols IS NULL THEN
    RAISE EXCEPTION 'VTID-05569: public.tenants has neither tenant_id nor id' USING ERRCODE = 'undefined_column';
  END IF;
  SELECT string_agg(format('SELECT %I::uuid FROM public.tenants', col), ' UNION ') INTO v_tenants FROM unnest(v_cols) AS col;

  FOREACH v_t IN ARRAY ARRAY['chat_messages', 'user_notifications', 'product_analytics_events'] LOOP
    SELECT c.is_nullable INTO v_nullable
      FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = v_t AND c.column_name = 'tenant_id';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'VTID-05569: public.%.tenant_id does not exist', v_t USING ERRCODE = 'undefined_column';
    END IF;
    IF v_nullable <> 'NO' THEN
      RAISE EXCEPTION 'VTID-05569: public.%.tenant_id is nullable; re-plan the expand/contract (spec section 4.7), do not improvise', v_t
        USING ERRCODE = 'not_null_violation';
    END IF;

    EXECUTE format(
      'SELECT count(*) FROM public.%I x WHERE NOT EXISTS (SELECT 1 FROM (%s) t(id) WHERE t.id = x.tenant_id)', v_t, v_tenants)
      INTO v_orphans;
    IF v_orphans > 0 THEN
      RAISE EXCEPTION 'VTID-05569: public.% holds % row(s) whose tenant_id is not an existing tenant; run the orphan quarantine (VTID-05571) first', v_t, v_orphans
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    RAISE NOTICE 'VTID-05569: public.%.tenant_id is NOT NULL and has no orphan rows', v_t;
  END LOOP;
END
$assert$;

COMMIT;
