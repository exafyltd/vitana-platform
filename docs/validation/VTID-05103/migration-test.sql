-- VTID-05103: runs the routine-runner migration against a throwaway local
-- Postgres with a minimal copy of the routines tables, then asserts it.
-- Never point this at a shared database. Usage, from the repo root:
--   psql -v ON_ERROR_STOP=1 -h <local socket> -p <port> -U postgres -f docs/validation/VTID-05103/migration-test.sql

DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Same definitions as 20260427130000_vtid_01981_routines_catalog.sql.
CREATE TABLE routines (
  name TEXT PRIMARY KEY, display_name TEXT NOT NULL, description TEXT, cron_schedule TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE, last_run_id UUID, last_run_at TIMESTAMPTZ,
  last_run_status TEXT CHECK (last_run_status IN ('running', 'success', 'failure', 'partial')),
  last_run_summary TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE routine_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  routine_name TEXT NOT NULL REFERENCES routines(name) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failure', 'partial')),
  trigger TEXT NOT NULL DEFAULT 'cron' CHECK (trigger IN ('cron', 'manual')),
  summary TEXT, findings JSONB, artifacts JSONB, error TEXT, duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO routines (name, display_name, cron_schedule, consecutive_failures) VALUES
  ('agents-heartbeat', 'Agents Heartbeat', '30 5 * * *', 2),
  ('dyk-tour-progress', 'DYK', '30 10 * * *', 0);
UPDATE routines SET enabled = false WHERE name = 'dyk-tour-progress';
-- An existing claude.ai run today must not block the gateway-runner claim.
INSERT INTO routine_runs (routine_name, status, trigger) VALUES ('agents-heartbeat', 'failure', 'cron');

\i supabase/migrations/20261012210000_vtid_05103_routine_runner_claim.sql
-- Idempotent: a second apply changes nothing and does not fail.
\i supabase/migrations/20261012210000_vtid_05103_routine_runner_claim.sql

DO $$
DECLARE
  first uuid; second uuid; disabled uuid; r record;
BEGIN
  -- 1. Seeded catalog row for mobile-screen-latency-rollup.
  IF NOT EXISTS (SELECT 1 FROM routines WHERE name = 'mobile-screen-latency-rollup' AND cron_schedule = '15 6 * * *') THEN
    RAISE EXCEPTION 'FAIL: mobile-screen-latency-rollup catalog row missing';
  END IF;

  -- 2. First claim today wins and marks the catalog running.
  first := claim_routine_run('agents-heartbeat');
  IF first IS NULL THEN RAISE EXCEPTION 'FAIL: first claim returned NULL'; END IF;
  SELECT * INTO r FROM routines WHERE name = 'agents-heartbeat';
  IF r.last_run_id <> first OR r.last_run_status <> 'running' THEN RAISE EXCEPTION 'FAIL: catalog not marked running'; END IF;

  -- 3. Second claim the same UTC day returns NULL (another task already has it).
  second := claim_routine_run('agents-heartbeat');
  IF second IS NOT NULL THEN RAISE EXCEPTION 'FAIL: double claim returned %', second; END IF;
  IF (SELECT count(*) FROM routine_runs WHERE routine_name = 'agents-heartbeat' AND trigger = 'gateway-runner') <> 1 THEN
    RAISE EXCEPTION 'FAIL: expected exactly one gateway-runner run';
  END IF;

  -- 4. A routine disabled in the catalog is never claimed.
  disabled := claim_routine_run('dyk-tour-progress');
  IF disabled IS NOT NULL THEN RAISE EXCEPTION 'FAIL: disabled routine was claimed'; END IF;
  IF claim_routine_run('no-such-routine') IS NOT NULL THEN RAISE EXCEPTION 'FAIL: unknown routine was claimed'; END IF;

  -- 5. finish → success resets consecutive_failures, closes the run.
  PERFORM finish_routine_run(first, 'success', 'ok', '{"a":1}'::jsonb, NULL);
  SELECT * INTO r FROM routine_runs WHERE id = first;
  IF r.status <> 'success' OR r.finished_at IS NULL OR r.duration_ms IS NULL OR r.findings <> '{"a":1}'::jsonb THEN
    RAISE EXCEPTION 'FAIL: run not closed correctly';
  END IF;
  SELECT * INTO r FROM routines WHERE name = 'agents-heartbeat';
  IF r.last_run_status <> 'success' OR r.consecutive_failures <> 0 OR r.last_run_summary <> 'ok' THEN
    RAISE EXCEPTION 'FAIL: catalog not updated on success';
  END IF;

  -- 6. A run from yesterday does not block today; finish → failure increments.
  UPDATE routine_runs SET started_at = started_at - interval '1 day' WHERE id = first;
  second := claim_routine_run('agents-heartbeat');
  IF second IS NULL THEN RAISE EXCEPTION 'FAIL: new UTC day could not claim'; END IF;
  PERFORM finish_routine_run(second, 'failure', 'boom', '{}'::jsonb, 'loader threw');
  SELECT * INTO r FROM routines WHERE name = 'agents-heartbeat';
  IF r.consecutive_failures <> 1 OR r.last_run_status <> 'failure' THEN RAISE EXCEPTION 'FAIL: failure not counted'; END IF;

  -- 7. The trigger check still rejects anything else.
  BEGIN
    INSERT INTO routine_runs (routine_name, status, trigger) VALUES ('agents-heartbeat', 'running', 'bogus');
    RAISE EXCEPTION 'FAIL: bogus trigger accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 8. EXECUTE for service_role only.
  IF has_function_privilege('anon', 'claim_routine_run(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'finish_routine_run(uuid, text, text, jsonb, text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'claim_routine_run(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: function grants wrong';
  END IF;

  RAISE NOTICE 'VTID-05103 migration test: all assertions passed';
END $$;
