-- VTID-05023 parts 8b + 12(i) — WINDOW STEP, run on SUPABASE (project inmkhvwdcuyhnxkgfvsb) only,
-- after supabase-cutover-unschedule.sql and BEFORE the Aurora->Supabase DMS CDC tasks start
-- (scripts/aws/aurora-to-supabase-cdc.sh). NOT run now. Rollback:
-- supabase-cutover-reverse-cdc-triggers-rollback.sql (run it BEFORE supabase-cutover-unschedule-rollback.sql).
--
-- Why: the plan wanted the CDC target in replica mode (AfterConnectScript=SET
-- session_replication_role=replica) so no Supabase trigger fires on replicated rows. Read live
-- 2026-10-10: Supabase's postgres role is not superuser and has no SET privilege on
-- session_replication_role, so that setting would fail the DMS connection. Instead every user
-- trigger on a public table is disabled here (152 tables / 239 triggers, all owned by postgres,
-- all enabled). Without this, trg_notify_chat_message would notify every chat message a second
-- time when the 8b task copies it back. Nothing else writes Supabase public after the flip
-- (write freeze + drift monitor, plan part 11), so no member-facing behaviour depends on them.
-- Internal (FK) triggers stay enabled.
--
-- Step 0 snapshots every user trigger's enabled state into vtid_05023_backup.trigger_state_snapshot
-- BEFORE anything is disabled; the rollback restores exactly that state. One statement per line.
-- Idempotent: re-running neither overwrites the first snapshot nor fails.
CREATE SCHEMA IF NOT EXISTS vtid_05023_backup;
REVOKE ALL ON SCHEMA vtid_05023_backup FROM PUBLIC;
CREATE TABLE IF NOT EXISTS vtid_05023_backup.trigger_state_snapshot (table_name text NOT NULL, trigger_name text NOT NULL, tgenabled "char" NOT NULL, snapshot_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (table_name, trigger_name));
INSERT INTO vtid_05023_backup.trigger_state_snapshot (table_name, trigger_name, tgenabled) SELECT c.relname, t.tgname, t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT t.tgisinternal ON CONFLICT (table_name, trigger_name) DO NOTHING;
DO $chk$ DECLARE n integer; BEGIN SELECT count(*) INTO n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT t.tgisinternal AND NOT EXISTS (SELECT 1 FROM vtid_05023_backup.trigger_state_snapshot s WHERE s.table_name = c.relname AND s.trigger_name = t.tgname); IF n > 0 THEN RAISE EXCEPTION 'VTID-05023: % user triggers are not in the snapshot — stop', n; END IF; END $chk$;
DO $dis$ DECLARE r record; BEGIN FOR r IN SELECT DISTINCT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT t.tgisinternal AND t.tgenabled <> 'D' ORDER BY c.relname LOOP EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER USER', r.relname); END LOOP; END $dis$;
DO $ver$ DECLARE n integer; BEGIN SELECT count(*) INTO n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT t.tgisinternal AND t.tgenabled <> 'D'; IF n > 0 THEN RAISE EXCEPTION 'VTID-05023: % user triggers on public tables are still enabled', n; END IF; RAISE NOTICE 'VTID-05023: every user trigger on public tables is disabled'; END $ver$;
