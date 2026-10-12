-- VTID-05103 — Loop Engineering Phase 3a: the in-gateway routine runner.
--
-- The deterministic daily routines now run inside the gateway
-- (services/gateway/src/services/routine-runner) instead of as claude.ai
-- sessions. Their runs are recorded in the same tables the Command Hub
-- Routines screen already reads (20260427130000_vtid_01981_routines_catalog.sql).
--
-- 1. routine_runs.trigger also accepts 'gateway-runner'.
-- 2. At most one gateway-runner run per routine per UTC day — a unique partial
--    index, so several gateway tasks can tick at the same time and only one
--    of them runs the routine.
-- 3. claim_routine_run(name): starts today's run, or returns NULL when the
--    routine is disabled in the catalog or another task already claimed it.
-- 4. finish_routine_run(...): closes the run and updates the catalog row
--    (last_run_*, consecutive_failures) in one statement each.
-- 5. Catalog row for mobile-screen-latency-rollup (spec existed, row did not).
--
-- Additive and idempotent. EXECUTE for service_role only.

BEGIN;

ALTER TABLE public.routine_runs DROP CONSTRAINT IF EXISTS routine_runs_trigger_check;
ALTER TABLE public.routine_runs ADD CONSTRAINT routine_runs_trigger_check
  CHECK (trigger IN ('cron', 'manual', 'gateway-runner'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_routine_runs_gateway_runner_day
  ON public.routine_runs (routine_name, ((started_at AT TIME ZONE 'UTC')::date))
  WHERE trigger = 'gateway-runner';

INSERT INTO public.routines (name, display_name, description, cron_schedule)
VALUES (
  'mobile-screen-latency-rollup',
  'Mobile Screen Latency Rollup',
  'Daily p75 of the RUM screen.latency.measured beacons for the 9 tracked mobile screens, per device; a screen over its poor cut is a breach. Spec: routines/mobile-screen-latency-rollup.md.',
  '15 6 * * *'
)
ON CONFLICT (name) DO NOTHING;

CREATE OR REPLACE FUNCTION public.claim_routine_run(p_name text)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.routines WHERE name = p_name AND enabled) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.routine_runs (routine_name, started_at, status, trigger)
  VALUES (p_name, now(), 'running', 'gateway-runner')
  ON CONFLICT (routine_name, ((started_at AT TIME ZONE 'UTC')::date)) WHERE trigger = 'gateway-runner'
  DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    UPDATE public.routines
       SET last_run_id = v_id, last_run_at = now(), last_run_status = 'running',
           last_run_summary = NULL, updated_at = now()
     WHERE name = p_name;
  END IF;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_routine_run(
  p_id uuid,
  p_status text,
  p_summary text,
  p_findings jsonb,
  p_error text
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_name text;
BEGIN
  UPDATE public.routine_runs
     SET status = p_status,
         summary = left(p_summary, 2000),
         findings = p_findings,
         error = p_error,
         finished_at = now(),
         duration_ms = GREATEST(0, (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::integer)
   WHERE id = p_id
  RETURNING routine_name INTO v_name;

  IF v_name IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.routines
     SET last_run_id = p_id,
         last_run_at = now(),
         last_run_status = p_status,
         last_run_summary = left(p_summary, 2000),
         consecutive_failures = CASE
           WHEN p_status = 'success' THEN 0
           WHEN p_status = 'failure' THEN consecutive_failures + 1
           ELSE consecutive_failures
         END,
         updated_at = now()
   WHERE name = v_name;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_routine_run(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_routine_run(uuid, text, text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_routine_run(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_routine_run(uuid, text, text, jsonb, text) TO service_role;

COMMIT;
