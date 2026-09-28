-- VTID-04680 — a goal plan no longer fills the member's calendar.
--
-- VTID-04356 mirrored every goal-plan step into calendar_events: each habit
-- became a daily series (08:00 local, until the plan's target date — some
-- plans end in 2036) and each weekly check-in became its own entry. A plan
-- has ~3 habits, so every day of a member's calendar carried 3-4 entries the
-- member never asked for, each with default reminders. Measured 2026-09-26:
-- 555 generated entries (61 daily habit series, 444 check-ins, 50
-- milestones) across 19 members.
--
-- The rule from now on: only things the member created or said yes to go
-- into the calendar. Habits and check-ins live in My Journey; the calendar
-- offers "add to my calendar" for a habit, which creates a normal entry the
-- member owns. Milestones stay: a plan has a handful, they are dates the
-- member chose when they set the goal, and the app shows them as a quiet
-- marker rather than a task.
--
-- This migration only changes what is written from now on. Entries that
-- already exist are cancelled by the one-shot data fix
-- data-fixups/20260928100100_vtid_04680_cancel_generated_goal_plan_entries.sql,
-- which is run separately, after review.

CREATE OR REPLACE FUNCTION public.calendar_sync_goal_plan_step(p_step public.goal_plan_steps)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_plan public.goal_plans%ROWTYPE;
  v_tz text;
  v_id uuid;
  v_ref text := p_step.id::text;
BEGIN
  SELECT * INTO v_plan FROM public.goal_plans WHERE id = p_step.plan_id;
  IF NOT FOUND OR v_plan.status <> 'active' THEN
    PERFORM public.calendar_cancel_source(p_step.user_id, 'goal_plan_step', v_ref);
    RETURN NULL;
  END IF;

  -- VTID-04680: habits and check-ins are never written to the calendar.
  IF p_step.kind IS DISTINCT FROM 'milestone' THEN
    RETURN NULL;
  END IF;

  IF p_step.scheduled_date IS NULL THEN RETURN NULL; END IF;
  v_tz := public.calendar_user_timezone(p_step.user_id);
  v_id := public.calendar_upsert_from_source(
    p_step.user_id, 'goal_plan', 'goal_plan_step', v_ref,
    p_step.title,
    (p_step.scheduled_date + time '09:00') AT TIME ZONE v_tz,
    (p_step.scheduled_date + time '09:30') AT TIME ZONE v_tz,
    'journey_milestone', p_step.description, NULL, '🏁',
    NULL, v_tz, NULL, 'community',
    jsonb_build_object('goal_plan_id', v_plan.id, 'goal_text', v_plan.goal_text, 'step_kind', p_step.kind)
  );
  PERFORM public.calendar_complete_source(p_step.user_id, 'goal_plan_step', v_ref, p_step.status = 'done');
  RETURN v_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.calendar_sync_goal_plan_step(public.goal_plan_steps) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.calendar_sync_goal_plan_step(public.goal_plan_steps) IS
  'VTID-04680: only goal-plan milestones reach the calendar; habits and check-ins stay in My Journey.';
