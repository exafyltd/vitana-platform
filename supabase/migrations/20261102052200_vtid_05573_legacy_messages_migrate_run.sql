-- VTID-05573 (mt-network-r2/legacy-messages-migration-db) step 3 of 4: move the legacy rows.
--
-- Runs public.mt_legacy_messages_migrate() (20261102052100) once. It reads only the bak_* snapshots taken by 20261102052000,
-- maps every legacy message by the single D15 rule and inserts the placeable ones into chat_messages / chat_groups /
-- chat_group_members under their legacy ids. Nothing is deleted here: the legacy tables are still there, frozen, and are dropped
-- by 20261102052300 only after the reconcile guard passes. Safe to re-run (no row is added twice).
-- The returned figures (per source: total = migrated + skipped_excluded + unplaced; threads by outcome) are the read-only
-- pre/post row-count record; post-apply-checks.sql prints the same counts from the tables.
-- Rollback: docs/validation/VTID-05573/rollback-052200-migrated-rows.sql.

-- impact-allow-solo-migration: one-time data move into chat_messages/chat_groups; nothing deployed reads the migrated rows before the messaging lanes.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '300s';

SELECT public.mt_legacy_messages_migrate();

COMMIT;
