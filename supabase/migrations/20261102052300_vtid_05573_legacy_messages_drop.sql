-- VTID-05573 (mt-network-r2/legacy-messages-migration-db) step 4 of 4 (CONTRACT): drop the four legacy messenger tables.
--
-- public.mt_legacy_messages_assert_ready() runs first and RAISES (so nothing is dropped, the transaction rolls back) unless
-- every legacy row is accounted for: unplaced = 0 and every migrated row is present in chat_messages / chat_groups. The
-- bak_* snapshots (20261102052000) stay for their 30-day retention and are the rollback source.
-- Foreign keys that other tables hold onto the four tables (the participant tables' thread_id keys) are dropped first, by
-- catalog lookup; the tables are then dropped WITHOUT CASCADE, so any other dependent object (a view, a policy on another
-- table, a function body bound by dependency) makes the drop fail loudly and roll back instead of disappearing silently.
-- thread_participants / global_thread_participants stay (they are not part of this lane's four); their rows are in bak_* too.
-- Apply only after the gateway and v1 stop reading the legacy tables (messaging lanes), on the owner's approval.
-- Rollback: docs/validation/VTID-05573/rollback-052300-drop-legacy.sql (recreates the tables and rows from bak_*).

-- impact-allow-solo-migration: drops retired tables whose rows are migrated and snapshotted; the guard refuses otherwise.

BEGIN;

SET LOCAL lock_timeout = '10s';

SELECT public.mt_legacy_messages_assert_ready();

DO $mig$
DECLARE
  v_fk record;
  v_legacy text[] := ARRAY['messages', 'message_threads', 'global_message_threads', 'global_messages'];
BEGIN
  FOR v_fk IN
    SELECT c.conrelid::regclass AS tbl, c.conname
      FROM pg_constraint c
     WHERE c.contype = 'f'
       AND c.confrelid IN (SELECT to_regclass('public.' || t) FROM unnest(v_legacy) t WHERE to_regclass('public.' || t) IS NOT NULL)
       AND c.conrelid NOT IN (SELECT to_regclass('public.' || t) FROM unnest(v_legacy) t WHERE to_regclass('public.' || t) IS NOT NULL)
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', v_fk.tbl, v_fk.conname);
  END LOOP;
END
$mig$;

DROP TABLE IF EXISTS public.global_messages;
DROP TABLE IF EXISTS public.messages;
DROP TABLE IF EXISTS public.global_message_threads;
DROP TABLE IF EXISTS public.message_threads;

COMMIT;
