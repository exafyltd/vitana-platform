-- VTID-05023 part 8: PostgREST schema-cache auto-reload on Aurora.
-- The PostgREST-documented event triggers ("Automatic schema cache reloading"):
-- every DDL command that changes what PostgREST exposes, and every drop, sends
-- NOTIFY pgrst, 'reload schema' — so a migration applied by any route (not only
-- aurora-apply-migration.sh, which also sends it) reaches the proxy's PostgREST.
-- Supabase ships the same pair (pgrst_ddl_watch / pgrst_drop_watch); DMS does
-- not copy event triggers, so Aurora has none until this runs.
-- Needs rds_superuser on RDS/Aurora (run as the master user, which
-- scripts/aws/aurora-run-sql.sh does). Idempotent: re-running replaces both.
-- Apply after the final full load (runbook "Part 8 — migrations"):
--   scripts/aws/aurora-run-sql.sh scripts/aws/aurora-pgrst-ddl-watch.sql
-- Contract of aurora-run-sql.sh: one statement per line, comment lines skipped.
-- The functions live in `extensions` (as on Supabase), outside PostgREST's exposed
-- schemas, so they never show up as RPCs.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE OR REPLACE FUNCTION extensions.pgrst_watch() RETURNS event_trigger LANGUAGE plpgsql AS $$ DECLARE cmd record; BEGIN FOR cmd IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP IF cmd.command_tag IN ('CREATE SCHEMA', 'ALTER SCHEMA', 'CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO', 'ALTER TABLE', 'CREATE FOREIGN TABLE', 'ALTER FOREIGN TABLE', 'CREATE VIEW', 'ALTER VIEW', 'CREATE MATERIALIZED VIEW', 'ALTER MATERIALIZED VIEW', 'CREATE FUNCTION', 'ALTER FUNCTION', 'CREATE TRIGGER', 'CREATE TYPE', 'ALTER TYPE', 'CREATE RULE', 'COMMENT') AND cmd.schema_name IS DISTINCT FROM 'pg_temp' THEN NOTIFY pgrst, 'reload schema'; END IF; END LOOP; END; $$;
CREATE OR REPLACE FUNCTION extensions.pgrst_drop_watch() RETURNS event_trigger LANGUAGE plpgsql AS $$ DECLARE obj record; BEGIN FOR obj IN SELECT * FROM pg_event_trigger_dropped_objects() LOOP IF obj.object_type IN ('schema', 'table', 'foreign table', 'view', 'materialized view', 'function', 'trigger', 'type', 'rule') AND obj.is_temporary IS false THEN NOTIFY pgrst, 'reload schema'; END IF; END LOOP; END; $$;
-- Supabase's own names, in case a schema copy ever brought them over: one watcher only.
DROP EVENT TRIGGER IF EXISTS pgrst_ddl_watch;
DROP EVENT TRIGGER IF EXISTS pgrst_watch;
CREATE EVENT TRIGGER pgrst_watch ON ddl_command_end EXECUTE FUNCTION extensions.pgrst_watch();
DROP EVENT TRIGGER IF EXISTS pgrst_drop_watch;
CREATE EVENT TRIGGER pgrst_drop_watch ON sql_drop EXECUTE FUNCTION extensions.pgrst_drop_watch();
REVOKE ALL ON FUNCTION extensions.pgrst_watch() FROM PUBLIC;
REVOKE ALL ON FUNCTION extensions.pgrst_drop_watch() FROM PUBLIC;
