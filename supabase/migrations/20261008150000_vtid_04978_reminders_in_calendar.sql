-- VTID-04978 — one-shot personal reminders show up in the member's Maxina calendar.
--
-- A reminder set by voice ("remind me at 15:00 to call mum") or in the app lives
-- only in `reminders`, so the calendar never showed it. This mirrors each
-- one-shot personal reminder into `calendar_events` with a database trigger
-- (same approach as VTID-04915 / VTID-04965):
--   * new reminder (pending)            -> one calendar row, source_type 'reminder'
--   * snooze / time edit (pending again) -> the row moves; a cancelled row is revived
--   * fired / dispatching                -> row stays where it is
--   * completed                          -> row marked completion_status 'completed'
--   * cancelled / failed / deleted       -> row cancelled
-- Only reminders the member made: created_via IN ('voice','ui'), not linked to a
-- calendar entry (calendar_event_id IS NULL — the calendar's own 'system' reminders
-- are excluded, so there is no loop), and not recurring (recurrence_rule IS NULL).
-- The mirror row carries reminder_offsets = '{}' so the calendar adds no second
-- reminder in front of the one the member already set.
-- Backfill: pending, future reminders that already exist, except registered
-- test/service accounts. Idempotent: safe to run twice.
-- impact-allow-solo-migration: triggers + backfill on existing tables; the gateway type list and the frontend display ship in sibling PRs of the same VTID.

-- 1. Allow the new source type (recreate, keeping every existing value).
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.calendar_events'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%source_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.calendar_events DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE public.calendar_events ADD CONSTRAINT valid_source_type
  CHECK (source_type IN (
    'manual', 'invite', 'imported', 'autopilot', 'community_rsvp', 'assistant',
    'journey', 'vtid', 'ci_cd', 'nudge_engine',
    'health_plan', 'lab_order', 'appointment', 'live_room', 'goal_plan', 'guided_journey',
    'reminder'
  ));

-- 2. Mirror function.
CREATE OR REPLACE FUNCTION public.fn_reminder_to_calendar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE public.calendar_events c
       SET status = 'cancelled', updated_at = now()
     WHERE c.user_id = OLD.user_id
       AND c.status <> 'cancelled'
       AND c.source_type = 'reminder'
       AND c.source_ref_type = 'reminder'
       AND c.source_ref_id = OLD.id::text;
    RETURN OLD;
  END IF;

  IF NEW.status IN ('cancelled', 'failed') THEN
    UPDATE public.calendar_events c
       SET status = 'cancelled', updated_at = now()
     WHERE c.user_id = NEW.user_id
       AND c.status <> 'cancelled'
       AND c.source_type = 'reminder'
       AND c.source_ref_type = 'reminder'
       AND c.source_ref_id = NEW.id::text;
    RETURN NEW;
  END IF;

  IF NEW.status = 'completed' THEN
    UPDATE public.calendar_events c
       SET completion_status = 'completed', updated_at = now()
     WHERE c.user_id = NEW.user_id
       AND c.source_type = 'reminder'
       AND c.source_ref_type = 'reminder'
       AND c.source_ref_id = NEW.id::text;
    RETURN NEW;
  END IF;

  IF NEW.status <> 'pending' THEN
    RETURN NEW; -- dispatching / fired: the entry stays where it is
  END IF;

  IF EXISTS (SELECT 1 FROM public.service_bot_accounts WHERE user_id = NEW.user_id)
     OR EXISTS (SELECT 1 FROM public.notification_test_actors WHERE user_id = NEW.user_id) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.calendar_events (
    user_id, title, description, start_time, end_time,
    event_type, source_type, source_ref_id, source_ref_type,
    status, role_context, reminder_offsets, metadata
  ) VALUES (
    NEW.user_id,
    COALESCE(NULLIF(NEW.action_text, ''), 'Reminder'),
    NEW.description,
    NEW.next_fire_at,
    NEW.next_fire_at + interval '15 minutes',
    'personal', 'reminder', NEW.id::text, 'reminder',
    'confirmed', 'personal', '{}'::int[],
    jsonb_build_object('reminder_id', NEW.id::text)
  )
  ON CONFLICT (user_id, source_ref_id, source_ref_type) WHERE source_ref_id IS NOT NULL
  DO UPDATE SET status = 'confirmed',
                completion_status = NULL,
                title = EXCLUDED.title,
                description = EXCLUDED.description,
                start_time = EXCLUDED.start_time,
                end_time = EXCLUDED.end_time,
                updated_at = now();
  RETURN NEW;
END;
$function$;

-- 3. Triggers; the WHEN clause keeps every non-member-made or recurring reminder out.
DROP TRIGGER IF EXISTS trg_reminder_insert_calendar ON public.reminders;
CREATE TRIGGER trg_reminder_insert_calendar
  AFTER INSERT ON public.reminders
  FOR EACH ROW
  WHEN (NEW.created_via IN ('voice', 'ui') AND NEW.calendar_event_id IS NULL AND NEW.recurrence_rule IS NULL)
  EXECUTE FUNCTION public.fn_reminder_to_calendar();

DROP TRIGGER IF EXISTS trg_reminder_update_calendar ON public.reminders;
CREATE TRIGGER trg_reminder_update_calendar
  AFTER UPDATE OF status, next_fire_at, action_text, description ON public.reminders
  FOR EACH ROW
  WHEN (NEW.created_via IN ('voice', 'ui') AND NEW.calendar_event_id IS NULL AND NEW.recurrence_rule IS NULL
        AND (OLD.status IS DISTINCT FROM NEW.status
             OR OLD.next_fire_at IS DISTINCT FROM NEW.next_fire_at
             OR OLD.action_text IS DISTINCT FROM NEW.action_text
             OR OLD.description IS DISTINCT FROM NEW.description))
  EXECUTE FUNCTION public.fn_reminder_to_calendar();

DROP TRIGGER IF EXISTS trg_reminder_delete_calendar ON public.reminders;
CREATE TRIGGER trg_reminder_delete_calendar
  AFTER DELETE ON public.reminders
  FOR EACH ROW
  WHEN (OLD.created_via IN ('voice', 'ui') AND OLD.calendar_event_id IS NULL AND OLD.recurrence_rule IS NULL)
  EXECUTE FUNCTION public.fn_reminder_to_calendar();

COMMENT ON FUNCTION public.fn_reminder_to_calendar() IS
  'VTID-04978: mirrors one-shot member reminders (voice/ui, not calendar-linked) into calendar_events (source_type reminder).';

-- 4. One-time backfill: pending, future reminders that already exist.
INSERT INTO public.calendar_events (
  user_id, title, description, start_time, end_time,
  event_type, source_type, source_ref_id, source_ref_type,
  status, role_context, reminder_offsets, metadata
)
SELECT r.user_id,
       COALESCE(NULLIF(r.action_text, ''), 'Reminder'),
       r.description,
       r.next_fire_at,
       r.next_fire_at + interval '15 minutes',
       'personal', 'reminder', r.id::text, 'reminder',
       'confirmed', 'personal', '{}'::int[],
       jsonb_build_object('reminder_id', r.id::text)
  FROM public.reminders r
 WHERE r.status = 'pending'
   AND r.next_fire_at > now()
   AND r.created_via IN ('voice', 'ui')
   AND r.calendar_event_id IS NULL
   AND r.recurrence_rule IS NULL
   AND NOT EXISTS (SELECT 1 FROM public.service_bot_accounts b WHERE b.user_id = r.user_id)
   AND NOT EXISTS (SELECT 1 FROM public.notification_test_actors t WHERE t.user_id = r.user_id)
ON CONFLICT (user_id, source_ref_id, source_ref_type) WHERE source_ref_id IS NOT NULL DO NOTHING;

REVOKE ALL ON FUNCTION public.fn_reminder_to_calendar() FROM PUBLIC, anon, authenticated;
