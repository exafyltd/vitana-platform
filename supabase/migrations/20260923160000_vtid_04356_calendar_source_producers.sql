-- VTID-04356 — calendar step 5: every accepted plan, order, booking and room
-- lands in the calendar.
--
-- Before this, only Autopilot activations, assistant tool calls, manual
-- entries and (since VTID-04321) community sign-ups reached calendar_events.
-- The other sources were written by paths the gateway never sees — the
-- Stripe booking webhook, the health-plan edge function, the lab order flow,
-- the live-room ticket flow — and the one gateway producer that existed, the
-- goal-plan mirror (goal-planner-service.mirrorStepsToCalendar), had never
-- written a single row: it posted one bulk insert whose habit rows carried a
-- key the milestone rows did not (recurring_pattern), PostgREST rejects a
-- bulk insert with mismatched keys, and the failure was caught as non-fatal.
-- Live on 2026-09-23: 1,024 goal-plan steps across 25 active plans, 0 of
-- them in any calendar.
--
-- A trigger per source table is the only place every writer passes through,
-- so that is where the producer contract lives for these sources. All of
-- them go through ONE upsert, calendar_upsert_from_source(), which is the SQL
-- twin of calendar-producers.ts (VTID-04331):
--   * idempotent on (user_id, source_ref_id, source_ref_type) — the partial
--     unique index idx_calendar_events_source_ref;
--   * a completed entry keeps its completion (never moved, never reopened);
--   * a cancelled entry the source sends again is reactivated;
--   * an unchanged entry is not rewritten (no updated_at churn).
-- Every trigger body is wrapped so a calendar failure raises a WARNING and
-- never fails the source write (a booking or a plan must never be lost
-- because its calendar row could not be written).
--
-- Sources connected here:
--   goal_plan_steps        milestone/checkpoint -> one entry on its date,
--                          09:00 local; habit -> one daily series 08:00 local
--                          from plan start to target date. Done <-> completed
--                          both ways (the reverse is completeSourceForCalendarEvent).
--   goal_plans             leaving 'active' (superseded by a new plan,
--                          cancelled) cancels the open entries of its steps.
--   user_health_plans      an active plan -> one daily series at a time that
--                          fits its type, for the plan's duration.
--   provider_appointments  paid (scheduled/confirmed) -> entry; pending
--                          (checkout not paid) never shows; cancelled ->
--                          cancelled; completed -> completed.
--   lab_test_orders        confirmed with a date -> lab entry (lab reminder
--                          rules: evening before + 1 h); sample collected or
--                          later -> completed; cancelled -> cancelled.
--   live_room_sessions     the host gets the session; every valid ticket
--   live_room_access_grants holder gets it too; moving the session moves
--                          everyone's entry; cancelling cancels them.
--
-- Not connected, on purpose:
--   partner_health_test_orders  — no appointment time exists (the sample is
--                                 mailed); results surface through the
--                                 partner-health continuation provider.
--   guided journey              — journey tasks/milestones already live in
--                                 the calendar (source_type 'journey').
--
-- Backfill at the end: open future goal-plan steps of active plans, active
-- health plans, paid future appointments, confirmed future lab orders and
-- future live-room sessions. Past items are not written — a calendar full of
-- missed checkpoints is noise, not a plan. Writing a calendar row sends
-- nothing by itself: reminders come only from the calendar-reminders loop
-- (VTID-04338), which looks 36 h ahead.

-- ─── helpers ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.calendar_user_timezone(p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT p.timezone
       FROM public.profiles p
      WHERE (p.user_id = p_user_id OR p.id = p_user_id)
        AND NULLIF(btrim(p.timezone), '') IS NOT NULL
        AND upper(p.timezone) <> 'UTC'
        AND EXISTS (SELECT 1 FROM pg_timezone_names n WHERE n.name = p.timezone)
      LIMIT 1),
    'Europe/Berlin'
  );
$function$;

COMMENT ON FUNCTION public.calendar_user_timezone(uuid) IS
  'VTID-04356: the user''s IANA timezone for calendar producers (profiles.timezone, else Europe/Berlin — the gateway DEFAULT_USER_TIMEZONE).';

CREATE OR REPLACE FUNCTION public.calendar_upsert_from_source(
  p_user_id      uuid,
  p_source_type  text,
  p_ref_type     text,
  p_ref_id       text,
  p_title        text,
  p_start        timestamptz,
  p_end          timestamptz DEFAULT NULL,
  p_event_type   text DEFAULT 'personal',
  p_description  text DEFAULT NULL,
  p_location     text DEFAULT NULL,
  p_emoji        text DEFAULT NULL,
  p_rrule        text DEFAULT NULL,
  p_timezone     text DEFAULT NULL,
  p_pillar       text DEFAULT NULL,
  p_role_context text DEFAULT 'community',
  p_metadata     jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_ref_id IS NULL OR p_ref_type IS NULL OR p_start IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.calendar_events AS c (
    user_id, title, description, start_time, end_time, location,
    event_type, status, source_type, source_ref_type, source_ref_id,
    role_context, emoji, rrule, timezone, pillar, metadata
  ) VALUES (
    p_user_id, left(COALESCE(NULLIF(btrim(p_title), ''), '—'), 300), p_description, p_start, p_end, p_location,
    p_event_type, 'confirmed', p_source_type, p_ref_type, p_ref_id,
    p_role_context, p_emoji, p_rrule, p_timezone, p_pillar, COALESCE(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT (user_id, source_ref_id, source_ref_type) WHERE source_ref_id IS NOT NULL
  DO UPDATE SET
    title       = EXCLUDED.title,
    description = EXCLUDED.description,
    start_time  = EXCLUDED.start_time,
    end_time    = EXCLUDED.end_time,
    location    = EXCLUDED.location,
    event_type  = EXCLUDED.event_type,
    source_type = EXCLUDED.source_type,
    emoji       = EXCLUDED.emoji,
    rrule       = EXCLUDED.rrule,
    timezone    = EXCLUDED.timezone,
    pillar      = EXCLUDED.pillar,
    metadata    = COALESCE(c.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    status      = CASE WHEN c.status = 'cancelled' THEN 'confirmed' ELSE c.status END,
    updated_at  = now()
  WHERE c.completed_at IS NULL
    AND (
      c.status = 'cancelled'
      OR (c.title, c.description, c.start_time, c.end_time, c.location, c.event_type,
          c.source_type, c.emoji, c.rrule, c.timezone, c.pillar)
         IS DISTINCT FROM
         (EXCLUDED.title, EXCLUDED.description, EXCLUDED.start_time, EXCLUDED.end_time,
          EXCLUDED.location, EXCLUDED.event_type, EXCLUDED.source_type, EXCLUDED.emoji,
          EXCLUDED.rrule, EXCLUDED.timezone, EXCLUDED.pillar)
      OR NOT (COALESCE(c.metadata, '{}'::jsonb) @> EXCLUDED.metadata)
    )
  RETURNING c.id INTO v_id;

  IF v_id IS NULL THEN
    -- Unchanged or completed: the row exists, the WHERE skipped the update.
    SELECT c.id INTO v_id
      FROM public.calendar_events c
     WHERE c.user_id = p_user_id AND c.source_ref_type = p_ref_type AND c.source_ref_id = p_ref_id;
  END IF;
  RETURN v_id;
END;
$function$;

COMMENT ON FUNCTION public.calendar_upsert_from_source(uuid, text, text, text, text, timestamptz, timestamptz, text, text, text, text, text, text, text, text, jsonb) IS
  'VTID-04356: SQL twin of calendar-producers.upsertCalendarEntryFromSource — idempotent per source ref, keeps completions, reactivates cancelled entries.';

CREATE OR REPLACE FUNCTION public.calendar_cancel_source(p_user_id uuid, p_ref_type text, p_ref_id text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  n integer;
BEGIN
  UPDATE public.calendar_events
     SET status = 'cancelled', updated_at = now()
   WHERE user_id = p_user_id AND source_ref_type = p_ref_type AND source_ref_id = p_ref_id
     AND status <> 'cancelled' AND completed_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$function$;

CREATE OR REPLACE FUNCTION public.calendar_complete_source(p_user_id uuid, p_ref_type text, p_ref_id text, p_done boolean DEFAULT true)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  n integer;
BEGIN
  IF p_done THEN
    UPDATE public.calendar_events
       SET completed_at = now(), completion_status = 'completed',
           activated_at = COALESCE(activated_at, now()), updated_at = now()
     WHERE user_id = p_user_id AND source_ref_type = p_ref_type AND source_ref_id = p_ref_id
       AND status <> 'cancelled' AND completed_at IS NULL;
  ELSE
    -- Un-ticked at the source (My Journey lets a step go back to pending).
    UPDATE public.calendar_events
       SET completed_at = NULL, completion_status = NULL, updated_at = now()
     WHERE user_id = p_user_id AND source_ref_type = p_ref_type AND source_ref_id = p_ref_id
       AND completed_at IS NOT NULL;
  END IF;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$function$;

-- Only the service role (gateway) and the triggers below call these.
REVOKE ALL ON FUNCTION public.calendar_user_timezone(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.calendar_upsert_from_source(uuid, text, text, text, text, timestamptz, timestamptz, text, text, text, text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.calendar_cancel_source(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.calendar_complete_source(uuid, text, text, boolean) FROM PUBLIC, anon, authenticated;

-- RRULE UNTIL for the end of a local date, in the UTC form the CHECK accepts.
CREATE OR REPLACE FUNCTION public.calendar_rrule_until(p_date date, p_tz text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT to_char(((p_date + time '23:59:59') AT TIME ZONE p_tz) AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS"Z"');
$function$;

-- ─── goal plans ────────────────────────────────────────────────────────────

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
  v_rank integer := 0;
  v_ref text := p_step.id::text;
BEGIN
  SELECT * INTO v_plan FROM public.goal_plans WHERE id = p_step.plan_id;
  IF NOT FOUND OR v_plan.status <> 'active' THEN
    PERFORM public.calendar_cancel_source(p_step.user_id, 'goal_plan_step', v_ref);
    RETURN NULL;
  END IF;

  v_tz := public.calendar_user_timezone(p_step.user_id);

  IF p_step.kind = 'habit' THEN
    IF v_plan.start_date IS NULL OR v_plan.target_date IS NULL THEN RETURN NULL; END IF;
    -- A plan has ~3 habits; all at 08:00 would be 3 reminders in the same
    -- minute every morning. Stagger them 30 min apart in plan order.
    SELECT LEAST(count(*), 8)::int INTO v_rank
      FROM public.goal_plan_steps o
     WHERE o.plan_id = p_step.plan_id AND o.kind = 'habit'
       AND (COALESCE(o.sort_order, 0), o.id) < (COALESCE(p_step.sort_order, 0), p_step.id);
    v_id := public.calendar_upsert_from_source(
      p_step.user_id, 'goal_plan', 'goal_plan_step', v_ref,
      p_step.title,
      (v_plan.start_date + time '08:00' + make_interval(mins => 30 * v_rank)) AT TIME ZONE v_tz,
      (v_plan.start_date + time '08:15' + make_interval(mins => 30 * v_rank)) AT TIME ZONE v_tz,
      'wellness_nudge', p_step.description, NULL, '🌱',
      'FREQ=DAILY;UNTIL=' || public.calendar_rrule_until(v_plan.target_date, v_tz),
      v_tz, NULL, 'community',
      jsonb_build_object('goal_plan_id', v_plan.id, 'goal_text', v_plan.goal_text, 'step_kind', p_step.kind)
    );
    -- A habit is a series: one "done" at the source is not "the whole series
    -- done", so completion is not mirrored for habits.
    RETURN v_id;
  END IF;

  IF p_step.scheduled_date IS NULL THEN RETURN NULL; END IF;
  v_id := public.calendar_upsert_from_source(
    p_step.user_id, 'goal_plan', 'goal_plan_step', v_ref,
    p_step.title,
    (p_step.scheduled_date + time '09:00') AT TIME ZONE v_tz,
    (p_step.scheduled_date + time '09:30') AT TIME ZONE v_tz,
    'journey_milestone', p_step.description, NULL,
    CASE WHEN p_step.kind = 'milestone' THEN '🏁' ELSE '🎯' END,
    NULL, v_tz, NULL, 'community',
    jsonb_build_object('goal_plan_id', v_plan.id, 'goal_text', v_plan.goal_text, 'step_kind', p_step.kind)
  );
  PERFORM public.calendar_complete_source(p_step.user_id, 'goal_plan_step', v_ref, p_step.status = 'done');
  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_goal_plan_step_to_calendar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      PERFORM public.calendar_cancel_source(OLD.user_id, 'goal_plan_step', OLD.id::text);
      RETURN OLD;
    END IF;
    v_id := public.calendar_sync_goal_plan_step(NEW);
    IF v_id IS NOT NULL AND NEW.calendar_event_id IS DISTINCT FROM v_id THEN
      -- calendar_event_id is not in this trigger's column list: no recursion.
      UPDATE public.goal_plan_steps SET calendar_event_id = v_id WHERE id = NEW.id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'VTID-04356 goal_plan_step % -> calendar failed: %', COALESCE(NEW.id, OLD.id), SQLERRM;
  END;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

DROP TRIGGER IF EXISTS trg_goal_plan_step_calendar ON public.goal_plan_steps;
CREATE TRIGGER trg_goal_plan_step_calendar
  AFTER INSERT OR UPDATE OF status, scheduled_date, title, description, kind OR DELETE
  ON public.goal_plan_steps
  FOR EACH ROW EXECUTE FUNCTION public.fn_goal_plan_step_to_calendar();

CREATE OR REPLACE FUNCTION public.fn_goal_plan_to_calendar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  s public.goal_plan_steps%ROWTYPE;
BEGIN
  BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      FOR s IN SELECT * FROM public.goal_plan_steps WHERE plan_id = NEW.id LOOP
        IF NEW.status = 'active' THEN
          PERFORM public.calendar_sync_goal_plan_step(s);
        ELSE
          PERFORM public.calendar_cancel_source(s.user_id, 'goal_plan_step', s.id::text);
        END IF;
      END LOOP;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'VTID-04356 goal_plan % -> calendar failed: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_goal_plan_calendar ON public.goal_plans;
CREATE TRIGGER trg_goal_plan_calendar
  AFTER UPDATE OF status ON public.goal_plans
  FOR EACH ROW EXECUTE FUNCTION public.fn_goal_plan_to_calendar();

-- ─── health plans ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.calendar_sync_health_plan(p_plan public.user_health_plans)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tz text;
  v_type text := lower(COALESCE(p_plan.plan_type, ''));
  v_pillar text;
  v_event_type text;
  v_emoji text;
  v_time time;
  v_days integer;
  v_duration text := lower(COALESCE(p_plan.plan_data->>'duration', ''));
  v_start_date date;
  v_desc text;
BEGIN
  IF NOT COALESCE(p_plan.active, false) THEN
    PERFORM public.calendar_cancel_source(p_plan.user_id, 'user_health_plan', p_plan.id::text);
    RETURN NULL;
  END IF;

  v_pillar := CASE
    WHEN v_type IN ('nutrition', 'hydration', 'exercise', 'sleep', 'mental') THEN v_type
    WHEN v_type IN ('fitness', 'workout', 'movement') THEN 'exercise'
    WHEN v_type IN ('stress', 'mindfulness', 'meditation') THEN 'mental'
    ELSE NULL END;
  v_event_type := CASE v_pillar
    WHEN 'nutrition' THEN 'nutrition' WHEN 'hydration' THEN 'nutrition'
    WHEN 'exercise' THEN 'workout' ELSE 'wellness_nudge' END;
  v_emoji := CASE v_pillar
    WHEN 'nutrition' THEN '🥗' WHEN 'hydration' THEN '💧' WHEN 'exercise' THEN '🏃'
    WHEN 'sleep' THEN '😴' WHEN 'mental' THEN '🧘' ELSE '📋' END;
  v_time := CASE v_pillar
    WHEN 'hydration' THEN time '10:00' WHEN 'nutrition' THEN time '12:30'
    WHEN 'exercise' THEN time '18:00' WHEN 'sleep' THEN time '21:30'
    WHEN 'mental' THEN time '08:00' ELSE time '09:00' END;

  v_days := CASE
    WHEN v_duration ~ '(\d+)\s*week' THEN (substring(v_duration FROM '(\d+)\s*week'))::int * 7
    WHEN v_duration ~ '(\d+)\s*month' THEN (substring(v_duration FROM '(\d+)\s*month'))::int * 30
    WHEN v_duration ~ '(\d+)\s*(day|tag)' THEN (substring(v_duration FROM '(\d+)\s*(?:day|tag)'))::int
    ELSE 28 END;
  v_days := LEAST(GREATEST(v_days, 1), 365);

  v_tz := public.calendar_user_timezone(p_plan.user_id);
  v_start_date := (COALESCE(p_plan.generated_at, p_plan.created_at, now()) AT TIME ZONE v_tz)::date;

  SELECT string_agg('• ' || r, E'\n')
    INTO v_desc
    FROM (
      SELECT jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(p_plan.plan_data->'recommendations') = 'array'
                    THEN p_plan.plan_data->'recommendations' ELSE '[]'::jsonb END) AS r
      LIMIT 3
    ) x;

  RETURN public.calendar_upsert_from_source(
    p_plan.user_id, 'health_plan', 'user_health_plan', p_plan.id::text,
    COALESCE(NULLIF(btrim(p_plan.plan_data->>'planName'), ''), initcap(v_type)),
    (v_start_date + v_time) AT TIME ZONE v_tz,
    (v_start_date + v_time + interval '15 minutes') AT TIME ZONE v_tz,
    v_event_type, v_desc, NULL, v_emoji,
    'FREQ=DAILY;COUNT=' || v_days,
    v_tz, v_pillar, 'community',
    jsonb_build_object('plan_type', p_plan.plan_type, 'url', '/health')
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_health_plan_to_calendar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      PERFORM public.calendar_cancel_source(OLD.user_id, 'user_health_plan', OLD.id::text);
      RETURN OLD;
    END IF;
    PERFORM public.calendar_sync_health_plan(NEW);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'VTID-04356 user_health_plan % -> calendar failed: %', COALESCE(NEW.id, OLD.id), SQLERRM;
  END;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

DROP TRIGGER IF EXISTS trg_health_plan_calendar ON public.user_health_plans;
CREATE TRIGGER trg_health_plan_calendar
  AFTER INSERT OR UPDATE OF active, plan_data, plan_type OR DELETE
  ON public.user_health_plans
  FOR EACH ROW EXECUTE FUNCTION public.fn_health_plan_to_calendar();

-- ─── provider appointments ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.calendar_sync_appointment(p_appt public.provider_appointments)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_status text := lower(COALESCE(p_appt.status, ''));
  v_ref text := p_appt.id::text;
  v_id uuid;
BEGIN
  IF v_status IN ('scheduled', 'confirmed', 'completed') AND p_appt.start_time IS NOT NULL THEN
    v_id := public.calendar_upsert_from_source(
      p_appt.user_id, 'appointment', 'provider_appointment', v_ref,
      COALESCE(NULLIF(btrim(p_appt.provider_name), ''), NULLIF(btrim(p_appt.appointment_type), ''), NULLIF(btrim(p_appt.provider_specialty), '')),
      p_appt.start_time,
      COALESCE(p_appt.end_time, p_appt.start_time + make_interval(mins => COALESCE(p_appt.duration_minutes, 30))),
      'health',
      NULLIF(concat_ws(' · ', NULLIF(btrim(p_appt.provider_specialty), ''), NULLIF(btrim(p_appt.appointment_type), '')), ''),
      p_appt.location, '🩺', NULL,
      public.calendar_user_timezone(p_appt.user_id), NULL, 'community',
      jsonb_build_object('provider_id', p_appt.provider_id, 'appointment_type', p_appt.appointment_type)
    );
    IF v_status = 'completed' THEN
      PERFORM public.calendar_complete_source(p_appt.user_id, 'provider_appointment', v_ref, true);
    END IF;
    RETURN v_id;
  END IF;
  -- pending (checkout not paid yet), cancelled, declined, refunded, no_show …
  PERFORM public.calendar_cancel_source(p_appt.user_id, 'provider_appointment', v_ref);
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_appointment_to_calendar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      PERFORM public.calendar_cancel_source(OLD.user_id, 'provider_appointment', OLD.id::text);
      RETURN OLD;
    END IF;
    PERFORM public.calendar_sync_appointment(NEW);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'VTID-04356 provider_appointment % -> calendar failed: %', COALESCE(NEW.id, OLD.id), SQLERRM;
  END;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

DROP TRIGGER IF EXISTS trg_appointment_calendar ON public.provider_appointments;
CREATE TRIGGER trg_appointment_calendar
  AFTER INSERT OR UPDATE OF status, start_time, end_time, duration_minutes, location, provider_name, appointment_type OR DELETE
  ON public.provider_appointments
  FOR EACH ROW EXECUTE FUNCTION public.fn_appointment_to_calendar();

-- ─── lab test orders ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.calendar_sync_lab_order(p_order public.lab_test_orders)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_status text := p_order.status::text;
  v_ref text := p_order.id::text;
  v_name text;
  v_id uuid;
BEGIN
  IF v_status IN ('confirmed', 'sample_collected', 'processing', 'completed') AND p_order.scheduled_date IS NOT NULL THEN
    SELECT t.name INTO v_name FROM public.lab_tests t WHERE t.id = p_order.lab_test_id;
    v_id := public.calendar_upsert_from_source(
      p_order.user_id, 'lab_order', 'lab_test_order', v_ref,
      v_name,
      p_order.scheduled_date,
      p_order.scheduled_date + interval '30 minutes',
      'health', p_order.special_instructions, p_order.facility_address, '🧪', NULL,
      public.calendar_user_timezone(p_order.user_id), NULL, 'community',
      jsonb_build_object('lab_test_id', p_order.lab_test_id, 'collection_method', p_order.collection_method::text)
    );
    IF v_status <> 'confirmed' THEN
      -- The sample was taken: the calendar entry has happened.
      PERFORM public.calendar_complete_source(p_order.user_id, 'lab_test_order', v_ref, true);
    END IF;
    RETURN v_id;
  END IF;
  PERFORM public.calendar_cancel_source(p_order.user_id, 'lab_test_order', v_ref);
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_lab_order_to_calendar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      PERFORM public.calendar_cancel_source(OLD.user_id, 'lab_test_order', OLD.id::text);
      RETURN OLD;
    END IF;
    PERFORM public.calendar_sync_lab_order(NEW);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'VTID-04356 lab_test_order % -> calendar failed: %', COALESCE(NEW.id, OLD.id), SQLERRM;
  END;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

DROP TRIGGER IF EXISTS trg_lab_order_calendar ON public.lab_test_orders;
CREATE TRIGGER trg_lab_order_calendar
  AFTER INSERT OR UPDATE OF status, scheduled_date, facility_address, special_instructions OR DELETE
  ON public.lab_test_orders
  FOR EACH ROW EXECUTE FUNCTION public.fn_lab_order_to_calendar();

-- ─── live rooms ────────────────────────────────────────────────────────────

-- One user's entry for one live-room session (host or ticket holder).
CREATE OR REPLACE FUNCTION public.calendar_sync_live_room_entry(p_user_id uuid, p_session public.live_room_sessions, p_is_host boolean)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room_title text;
  v_ref text := p_session.id::text;
BEGIN
  IF p_user_id IS NULL THEN RETURN NULL; END IF;
  IF p_session.status = 'cancelled' OR p_session.starts_at IS NULL THEN
    PERFORM public.calendar_cancel_source(p_user_id, 'live_room_session', v_ref);
    RETURN NULL;
  END IF;
  IF p_session.status = 'ended' THEN
    RETURN NULL; -- it happened; leave the entry as it was
  END IF;
  SELECT r.title INTO v_room_title FROM public.live_rooms r WHERE r.id = p_session.room_id;
  RETURN public.calendar_upsert_from_source(
    p_user_id, 'live_room', 'live_room_session', v_ref,
    COALESCE(NULLIF(btrim(p_session.session_title), ''), v_room_title),
    p_session.starts_at,
    COALESCE(p_session.ends_at, p_session.starts_at + interval '1 hour'),
    'community', NULL, NULL, '🎥', NULL,
    public.calendar_user_timezone(p_user_id), NULL, 'community',
    jsonb_build_object('live_room_id', p_session.room_id, 'is_host', p_is_host, 'url', '/live/' || p_session.room_id::text)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_live_room_session_to_calendar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_host uuid;
  g record;
BEGIN
  BEGIN
    SELECT r.host_user_id INTO v_host FROM public.live_rooms r WHERE r.id = NEW.room_id;
    PERFORM public.calendar_sync_live_room_entry(v_host, NEW, true);
    FOR g IN
      SELECT DISTINCT a.user_id FROM public.live_room_access_grants a
       WHERE a.session_id = NEW.id AND a.is_valid AND NOT a.is_revoked
         AND a.user_id IS DISTINCT FROM v_host
    LOOP
      PERFORM public.calendar_sync_live_room_entry(g.user_id, NEW, false);
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'VTID-04356 live_room_session % -> calendar failed: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_live_room_session_calendar ON public.live_room_sessions;
CREATE TRIGGER trg_live_room_session_calendar
  AFTER INSERT OR UPDATE OF status, starts_at, ends_at, session_title
  ON public.live_room_sessions
  FOR EACH ROW EXECUTE FUNCTION public.fn_live_room_session_to_calendar();

CREATE OR REPLACE FUNCTION public.fn_live_room_grant_to_calendar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_session public.live_room_sessions%ROWTYPE;
BEGIN
  BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.session_id IS NOT NULL
       AND (TG_OP = 'DELETE' OR OLD.session_id IS DISTINCT FROM NEW.session_id OR NOT NEW.is_valid OR NEW.is_revoked) THEN
      -- Only cancel when no other valid ticket for the same session remains.
      IF NOT EXISTS (
        SELECT 1 FROM public.live_room_access_grants a
         WHERE a.user_id = OLD.user_id AND a.session_id = OLD.session_id
           AND a.is_valid AND NOT a.is_revoked AND a.id <> OLD.id
      ) THEN
        PERFORM public.calendar_cancel_source(OLD.user_id, 'live_room_session', OLD.session_id::text);
      END IF;
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.session_id IS NOT NULL AND NEW.is_valid AND NOT NEW.is_revoked THEN
      SELECT * INTO v_session FROM public.live_room_sessions WHERE id = NEW.session_id;
      IF FOUND THEN
        PERFORM public.calendar_sync_live_room_entry(NEW.user_id, v_session, false);
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'VTID-04356 live_room_access_grant % -> calendar failed: %', COALESCE(NEW.id, OLD.id), SQLERRM;
  END;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

DROP TRIGGER IF EXISTS trg_live_room_grant_calendar ON public.live_room_access_grants;
CREATE TRIGGER trg_live_room_grant_calendar
  AFTER INSERT OR UPDATE OF is_valid, is_revoked, session_id OR DELETE
  ON public.live_room_access_grants
  FOR EACH ROW EXECUTE FUNCTION public.fn_live_room_grant_to_calendar();

-- The sync functions are SECURITY DEFINER and take a whole row, so a caller
-- could hand them a forged row for another user. Only the triggers (which run
-- as the function owner) and the service role may call them.
REVOKE ALL ON FUNCTION public.calendar_sync_goal_plan_step(public.goal_plan_steps) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.calendar_sync_health_plan(public.user_health_plans) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.calendar_sync_appointment(public.provider_appointments) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.calendar_sync_lab_order(public.lab_test_orders) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.calendar_sync_live_room_entry(uuid, public.live_room_sessions, boolean) FROM PUBLIC, anon, authenticated;

-- ─── backfill (future only) ────────────────────────────────────────────────

DO $backfill$
DECLARE
  s public.goal_plan_steps%ROWTYPE;
  h public.user_health_plans%ROWTYPE;
  a public.provider_appointments%ROWTYPE;
  o public.lab_test_orders%ROWTYPE;
  l public.live_room_sessions%ROWTYPE;
  v_id uuid;
BEGIN
  FOR s IN
    SELECT st.* FROM public.goal_plan_steps st
      JOIN public.goal_plans p ON p.id = st.plan_id
     WHERE p.status = 'active' AND st.status = 'pending'
       AND (st.kind = 'habit' OR st.scheduled_date >= current_date)
  LOOP
    v_id := public.calendar_sync_goal_plan_step(s);
    IF v_id IS NOT NULL THEN
      UPDATE public.goal_plan_steps SET calendar_event_id = v_id WHERE id = s.id AND calendar_event_id IS DISTINCT FROM v_id;
    END IF;
  END LOOP;

  FOR h IN SELECT * FROM public.user_health_plans WHERE active LOOP
    PERFORM public.calendar_sync_health_plan(h);
  END LOOP;

  FOR a IN SELECT * FROM public.provider_appointments WHERE start_time > now() AND lower(status) IN ('scheduled', 'confirmed') LOOP
    PERFORM public.calendar_sync_appointment(a);
  END LOOP;

  FOR o IN SELECT * FROM public.lab_test_orders WHERE scheduled_date > now() AND status::text = 'confirmed' LOOP
    PERFORM public.calendar_sync_lab_order(o);
  END LOOP;

  FOR l IN SELECT * FROM public.live_room_sessions WHERE starts_at > now() AND status NOT IN ('cancelled', 'ended') LOOP
    -- Reuse the session trigger body for host + ticket holders.
    UPDATE public.live_room_sessions SET session_title = session_title WHERE id = l.id;
  END LOOP;
END;
$backfill$;

COMMENT ON FUNCTION public.fn_goal_plan_step_to_calendar() IS 'VTID-04356: goal_plan_steps -> calendar_events (goal_plan / goal_plan_step).';
COMMENT ON FUNCTION public.fn_goal_plan_to_calendar() IS 'VTID-04356: a goal plan leaving active cancels its open calendar entries.';
COMMENT ON FUNCTION public.fn_health_plan_to_calendar() IS 'VTID-04356: an active user_health_plans row -> one daily calendar series.';
COMMENT ON FUNCTION public.fn_appointment_to_calendar() IS 'VTID-04356: paid provider_appointments -> calendar_events; pending/cancelled never show.';
COMMENT ON FUNCTION public.fn_lab_order_to_calendar() IS 'VTID-04356: confirmed lab_test_orders -> lab calendar entry.';
COMMENT ON FUNCTION public.fn_live_room_session_to_calendar() IS 'VTID-04356: live-room sessions -> host + ticket-holder calendar entries.';
COMMENT ON FUNCTION public.fn_live_room_grant_to_calendar() IS 'VTID-04356: a valid live-room ticket -> the session in the holder''s calendar.';
