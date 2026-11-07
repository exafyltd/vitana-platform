-- VTID-05573 rollback of 20261102052000 (run LAST, after rollback-052300). Unfreezes the four legacy tables: restores the
-- Supabase default table privileges for the API roles (row access stays decided by RLS; the restored tables have RLS on and no
-- member policy until the v1 chain is replayed). The bak_* snapshots are KEPT: they are dropped only by a later owner-approved
-- step after their 30-day retention.
BEGIN;
DO $rb$
DECLARE v_t text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['messages', 'message_threads', 'global_message_threads', 'global_messages'] LOOP
    IF to_regclass('public.' || v_t) IS NOT NULL THEN
      EXECUTE format('GRANT INSERT, UPDATE, DELETE, TRUNCATE ON public.%I TO service_role', v_t);
    END IF;
  END LOOP;
END
$rb$;
COMMIT;
