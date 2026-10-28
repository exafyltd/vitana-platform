-- VTID-04680 — cancel the goal-plan habit and check-in entries VTID-04356
-- generated in members' calendars.
--
-- One-shot data fix, run by a human-dispatched RUN-MIGRATION AFTER
-- 20260928100000_vtid_04680_goal_plans_keep_calendar_clean.sql is live
-- (otherwise the next step update would write them again), and only after
-- the platform owner has reviewed the rows (docs/validation/VTID-04680/).
--
-- Scope, deliberately narrow:
--   * rows the goal-plan trigger wrote: source_type 'goal_plan',
--     source_ref_type 'goal_plan_step';
--   * the step is a habit or a check-in (milestones stay);
--   * still open: not cancelled, not completed;
--   * never touched by the member: not moved (reschedule_count = 0,
--     original_start_time IS NULL) and never activated. Anything the member
--     acted on counts as a yes and stays.
--
-- Entries are cancelled, not deleted, so the fix is reversible. Their
-- pending system reminders are cancelled in the same transaction (the
-- reminder reconciler would do it on its next tick anyway).

BEGIN;

CREATE TEMP TABLE vtid_04680_cancel ON COMMIT DROP AS
SELECT e.id
  FROM public.calendar_events e
  JOIN public.goal_plan_steps s ON s.id::text = e.source_ref_id
 WHERE e.source_type = 'goal_plan'
   AND e.source_ref_type = 'goal_plan_step'
   AND s.kind IN ('habit', 'checkpoint')
   AND COALESCE(e.status, '') <> 'cancelled'
   AND e.completed_at IS NULL
   AND COALESCE(e.reschedule_count, 0) = 0
   AND e.original_start_time IS NULL
   AND e.activated_at IS NULL;

UPDATE public.reminders r
   SET status = 'cancelled', updated_at = now()
 WHERE r.calendar_event_id IN (SELECT id FROM vtid_04680_cancel)
   AND r.status = 'pending';

UPDATE public.calendar_events e
   SET status = 'cancelled', updated_at = now(),
       metadata = COALESCE(e.metadata, '{}'::jsonb) || jsonb_build_object('cancelled_by', 'VTID-04680')
 WHERE e.id IN (SELECT id FROM vtid_04680_cancel);

COMMIT;
