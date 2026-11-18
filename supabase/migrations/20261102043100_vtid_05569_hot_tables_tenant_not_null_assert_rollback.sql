-- impact-allow-solo-migration: no-op rollback; the forward file has no DDL and no data change.
-- VTID-05569 rollback of 20261102043000_vtid_05569_hot_tables_tenant_not_null_assert.sql.
--
-- The forward file is a read-only assertion: it creates, alters and writes nothing, so there is nothing to undo. This file
-- exists for the MIGRATION-QUEUE rollback contract (every queued row names a rollback). Replaying it changes nothing.
-- Do not add DDL here: the NOT NULL on chat_messages, user_notifications and product_analytics_events comes from their
-- original CREATE TABLE statements and must never be dropped by a rollback of this lane.

BEGIN;

DO $rollback$
BEGIN
  RAISE NOTICE 'VTID-05569 rollback: nothing to undo (the forward migration is assertion only)';
END
$rollback$;

COMMIT;
