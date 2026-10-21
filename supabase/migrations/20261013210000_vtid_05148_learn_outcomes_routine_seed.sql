-- VTID-05148: Loop Engineering Phase 4 (L3 Learn) — catalog row for the new
-- gateway-runner routine learn-outcomes. routine_runs.routine_name has a
-- foreign key on routines(name), so the routine needs its catalog row before
-- its first run.
--
-- Additive and idempotent: an existing row is left untouched.

BEGIN;

INSERT INTO public.routines (name, display_name, description, cron_schedule, enabled)
VALUES
  (
    'learn-outcomes',
    'Learn from Outcomes (L3)',
    'Daily (12:00 UTC): records which tests each fix PR shipped (self_healing_log.diagnosis.tests_added) and files one write_test finding for a fix without one; measures repeat-failure rate per class, pattern reuse and escaped bugs that became tests; on Mondays proposes (never applies) graduations from dev_autopilot_outcomes and withdraws regressed ones. Spec: routines/learn-outcomes.md.',
    '0 12 * * *',
    true
  )
ON CONFLICT (name) DO NOTHING;

COMMIT;
