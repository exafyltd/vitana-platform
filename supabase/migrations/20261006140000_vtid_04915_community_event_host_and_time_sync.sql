-- VTID-04915 — community events: the host gets a calendar entry, and moving
-- or editing an event moves everyone's entry.
--
-- VTID-04321 put attendees' sign-ups into the calendar
-- (trg_event_participation_calendar on global_event_participants). Two gaps
-- stayed open:
--   * the host: creating an event (web CreateEventPopup, the ORB
--     create_event/create_meetup tools) gave the host no calendar entry
--     unless the web popup wrote one itself;
--   * changes: editing an event's time, place or title left every
--     attendee's entry at the old values, and deleting an event left them
--     all in place.
--
-- This adds, on global_community_events:
--   * AFTER INSERT  -> the host's entry (created_by), same shape as the RSVP
--     trigger's rows (source_type 'community_rsvp', source_ref
--     (event id, 'community_event'), metadata.meetup_id/meetup_slug), plus
--     metadata.host = true. Skipped when the host already has a live row
--     for the event. A client-written row that arrives afterwards still
--     replaces it through VTID-04321's trg_calendar_dedupe_event_rsvp.
--   * AFTER UPDATE OF start_time, end_time, location, virtual_link, title,
--     description (only when one of them really changed) -> ONE set-based
--     UPDATE of every live entry for that event, host and attendees alike,
--     whichever path created it (source_ref or metadata.meetup_id). Pure
--     SQL: no per-row loop, no network call. Default reminders follow on
--     the next reconcile (calendar-reminders.ts), which rebuilds pending
--     reminder rows from the moved entry.
--   * AFTER DELETE -> ONE set-based cancel of every live entry for it.
--
-- Backfill: hosts of events that start in the future get their entry.

CREATE OR REPLACE FUNCTION public.fn_community_event_to_calendar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by IS NOT NULL AND NEW.start_time IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.calendar_events c
       WHERE c.user_id = NEW.created_by
         AND c.status <> 'cancelled'
         AND (c.metadata->>'meetup_id' = NEW.id::text
              OR (c.source_ref_id = NEW.id::text AND c.source_ref_type = 'community_event'))
    ) THEN
      INSERT INTO public.calendar_events (
        user_id, title, description, start_time, end_time, location,
        event_type, source_type, source_ref_id, source_ref_type,
        status, role_context, metadata
      ) VALUES (
        NEW.created_by,
        COALESCE(NULLIF(NEW.title, ''), 'Community event'),
        NEW.description,
        NEW.start_time,
        COALESCE(NEW.end_time, NEW.start_time + interval '1 hour'),
        COALESCE(NEW.location, NEW.virtual_link),
        'community',
        'community_rsvp',
        NEW.id::text,
        'community_event',
        'confirmed',
        'community',
        jsonb_build_object('meetup_id', NEW.id::text, 'meetup_slug', NEW.slug, 'host', true)
      )
      ON CONFLICT (user_id, source_ref_id, source_ref_type) WHERE source_ref_id IS NOT NULL
      DO UPDATE SET status = 'confirmed', updated_at = now()
        WHERE public.calendar_events.status = 'cancelled';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.start_time IS NOT NULL THEN
      UPDATE public.calendar_events c
         SET title = COALESCE(NULLIF(NEW.title, ''), c.title),
             description = NEW.description,
             start_time = NEW.start_time,
             end_time = COALESCE(NEW.end_time, NEW.start_time + interval '1 hour'),
             location = COALESCE(NEW.location, NEW.virtual_link),
             updated_at = now()
       WHERE c.status <> 'cancelled'
         AND (c.metadata->>'meetup_id' = NEW.id::text
              OR (c.source_ref_id = NEW.id::text AND c.source_ref_type = 'community_event'));
    END IF;
    RETURN NEW;
  END IF;

  -- DELETE
  UPDATE public.calendar_events c
     SET status = 'cancelled', updated_at = now()
   WHERE c.status <> 'cancelled'
     AND (c.metadata->>'meetup_id' = OLD.id::text
          OR (c.source_ref_id = OLD.id::text AND c.source_ref_type = 'community_event'));
  RETURN OLD;
END;
$function$;

DROP TRIGGER IF EXISTS trg_community_event_host_calendar ON public.global_community_events;
CREATE TRIGGER trg_community_event_host_calendar
  AFTER INSERT ON public.global_community_events
  FOR EACH ROW EXECUTE FUNCTION public.fn_community_event_to_calendar();

DROP TRIGGER IF EXISTS trg_community_event_change_calendar ON public.global_community_events;
CREATE TRIGGER trg_community_event_change_calendar
  AFTER UPDATE OF start_time, end_time, location, virtual_link, title, description
  ON public.global_community_events
  FOR EACH ROW
  WHEN (OLD.start_time IS DISTINCT FROM NEW.start_time
     OR OLD.end_time IS DISTINCT FROM NEW.end_time
     OR OLD.location IS DISTINCT FROM NEW.location
     OR OLD.virtual_link IS DISTINCT FROM NEW.virtual_link
     OR OLD.title IS DISTINCT FROM NEW.title
     OR OLD.description IS DISTINCT FROM NEW.description)
  EXECUTE FUNCTION public.fn_community_event_to_calendar();

DROP TRIGGER IF EXISTS trg_community_event_delete_calendar ON public.global_community_events;
CREATE TRIGGER trg_community_event_delete_calendar
  AFTER DELETE ON public.global_community_events
  FOR EACH ROW EXECUTE FUNCTION public.fn_community_event_to_calendar();

REVOKE ALL ON FUNCTION public.fn_community_event_to_calendar() FROM PUBLIC, anon, authenticated;

-- Backfill: hosts of future events.
INSERT INTO public.calendar_events (
  user_id, title, description, start_time, end_time, location,
  event_type, source_type, source_ref_id, source_ref_type,
  status, role_context, metadata
)
SELECT e.created_by,
       COALESCE(NULLIF(e.title, ''), 'Community event'),
       e.description,
       e.start_time,
       COALESCE(e.end_time, e.start_time + interval '1 hour'),
       COALESCE(e.location, e.virtual_link),
       'community', 'community_rsvp', e.id::text, 'community_event',
       'confirmed', 'community',
       jsonb_build_object('meetup_id', e.id::text, 'meetup_slug', e.slug, 'host', true)
  FROM public.global_community_events e
 WHERE e.created_by IS NOT NULL
   AND e.start_time > now()
   AND NOT EXISTS (
     SELECT 1 FROM public.calendar_events c
      WHERE c.user_id = e.created_by
        AND c.status <> 'cancelled'
        AND (c.metadata->>'meetup_id' = e.id::text
             OR (c.source_ref_id = e.id::text AND c.source_ref_type = 'community_event')))
ON CONFLICT (user_id, source_ref_id, source_ref_type) WHERE source_ref_id IS NOT NULL DO NOTHING;

COMMENT ON FUNCTION public.fn_community_event_to_calendar() IS
  'VTID-04915: host calendar entry on event insert; event time/place/title edits move every live entry; event delete cancels them.';
