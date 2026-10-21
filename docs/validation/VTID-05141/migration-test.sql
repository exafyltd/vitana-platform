-- VTID-05141: runs the seed migration against a throwaway local Postgres with a
-- minimal routines table, twice (idempotent), then asserts it.
-- Never point this at a shared database. From the repo root:
--   psql -v ON_ERROR_STOP=1 -h <local socket> -p <port> -U postgres -f docs/validation/VTID-05141/migration-test.sql
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
CREATE TABLE routines (
  name TEXT PRIMARY KEY, display_name TEXT NOT NULL, description TEXT, cron_schedule TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE, consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- A pre-existing, owner-edited row must not be overwritten.
INSERT INTO routines (name, display_name, cron_schedule, enabled) VALUES ('llm-fallback-watch', 'Edited', '15 7 * * *', false);
\i supabase/migrations/20261013190000_vtid_05141_phase3b_routine_seeds.sql
\i supabase/migrations/20261013190000_vtid_05141_phase3b_routine_seeds.sql
DO $$
BEGIN
  IF (SELECT count(*) FROM routines) <> 2 THEN RAISE EXCEPTION 'FAIL: expected 2 rows'; END IF;
  IF NOT EXISTS (SELECT 1 FROM routines WHERE name = 'llm-spend-budget' AND cron_schedule = '50 23 * * *' AND enabled) THEN
    RAISE EXCEPTION 'FAIL: llm-spend-budget row missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM routines WHERE name = 'llm-fallback-watch' AND display_name = 'Edited' AND NOT enabled) THEN
    RAISE EXCEPTION 'FAIL: existing row was overwritten'; END IF;
  RAISE NOTICE 'VTID-05141 migration test: all assertions passed';
END $$;
