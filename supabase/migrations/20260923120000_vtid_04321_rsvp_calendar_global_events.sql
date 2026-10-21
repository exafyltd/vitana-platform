-- VTID-04321 — community event sign-ups reach the calendar again.
--
-- The RSVP -> calendar trigger from 20260413000000_intelligent_calendar.sql
-- sits on event_attendance / community_meetups, which the app never writes
-- (0 rows). Real sign-ups go to global_event_participants (status
-- 'attending') for global_community_events — the web join button, the ORB
-- rsvp_event tool and ticket flows all write there — and nothing on that
-- table touched the calendar. Only the web join button added a calendar row
-- itself (client-side, source_type 'manual', metadata.meetup_id), so a voice
-- RSVP or any other path left the calendar empty.
--
-- This adds the trigger on the real table:
--   * attending (insert, or update into attending) -> one calendar row,
--     source_type 'community_rsvp', source_ref (event id, 'community_event'),
--     metadata.meetup_id/meetup_slug so the web client's leave path (which
--     deletes by metadata.meetup_id) still finds it. Skipped when the user
--     already has a live row for that event.
--   * leaving (delete, or update away from attending) -> every live row for
--     that user+event is cancelled, whichever path created it.
--
-- The web client still inserts its own row right after the participant
-- insert (useEventParticipation / MeetupDetailsDrawer), and a stale client
-- keeps doing so until it reloads. To keep exactly one row without making
-- that client error (its addEvent shows an error toast on any insert
-- failure), trg_calendar_dedupe_event_rsvp removes THIS trigger's row when a
-- client row for the same user+event arrives. The client row wins because
-- the client knows how to delete it again.
--
-- The old event_attendance trigger is left in place: dead, harmless.

CREATE OR REPLACE FUNCTION public.fn_event_participation_to_calendar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_event public.global_community_events%ROWTYPE;
  v_joining boolean;
  v_leaving boolean;
BEGIN
  v_joining := TG_OP IN ('INSERT', 'UPDATE')
    AND NEW.status = 'attending'
    AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'attending');

  v_leaving := (TG_OP = 'DELETE' AND OLD.status = 'attending')
    OR (TG_OP = 'UPDATE' AND OLD.status = 'attending' AND NEW.status IS DISTINCT FROM 'attending');

  IF v_joining THEN
    SELECT * INTO v_event FROM public.global_community_events WHERE id = NEW.event_id;
    IF FOUND AND v_event.start_time IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.calendar_events c
       WHERE c.user_id = NEW.user_id
         AND c.status <> 'cancelled'
         AND (c.metadata->>'meetup_id' = NEW.event_id::text
              OR (c.source_ref_id = NEW.event_id::text AND c.source_ref_type = 'community_event'))
    ) THEN
      INSERT INTO public.calendar_events (
        user_id, title, description, start_time, end_time, location,
        event_type, source_type, source_ref_id, source_ref_type,
        status, role_context, metadata
      ) VALUES (
        NEW.user_id,
        COALESCE(NULLIF(v_event.title, ''), 'Community event'),
        v_event.description,
        v_event.start_time,
        COALESCE(v_event.end_time, v_event.start_time + interval '1 hour'),
        COALESCE(v_event.location, v_event.virtual_link),
        'community',
        'community_rsvp',
        NEW.event_id::text,
        'community_event',
        'confirmed',
        'community',
        jsonb_build_object('meetup_id', NEW.event_id::text, 'meetup_slug', v_event.slug)
      )
      ON CONFLICT (user_id, source_ref_id, source_ref_type) WHERE source_ref_id IS NOT NULL
      DO UPDATE SET status = 'confirmed', updated_at = now()
        WHERE public.calendar_events.status = 'cancelled';
    END IF;
  END IF;

  IF v_leaving THEN
    UPDATE public.calendar_events c
       SET status = 'cancelled', updated_at = now()
     WHERE c.user_id = OLD.user_id
       AND c.status <> 'cancelled'
       AND (c.metadata->>'meetup_id' = OLD.event_id::text
            OR (c.source_ref_id = OLD.event_id::text AND c.source_ref_type = 'community_event'));
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

DROP TRIGGER IF EXISTS trg_event_participation_calendar ON public.global_event_participants;
CREATE TRIGGER trg_event_participation_calendar
  AFTER INSERT OR UPDATE OF status OR DELETE ON public.global_event_participants
  FOR EACH ROW EXECUTE FUNCTION public.fn_event_participation_to_calendar();

-- A client-written row for the same user+event supersedes the trigger's row.
CREATE OR REPLACE FUNCTION public.fn_calendar_dedupe_event_rsvp()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  DELETE FROM public.calendar_events c
   WHERE c.user_id = NEW.user_id
     AND c.id <> NEW.id
     AND c.source_type = 'community_rsvp'
     AND c.source_ref_type = 'community_event'
     AND c.source_ref_id = NEW.metadata->>'meetup_id';
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_calendar_dedupe_event_rsvp ON public.calendar_events;
CREATE TRIGGER trg_calendar_dedupe_event_rsvp
  AFTER INSERT ON public.calendar_events
  FOR EACH ROW
  WHEN (NEW.metadata ? 'meetup_id' AND NEW.source_type IS DISTINCT FROM 'community_rsvp')
  EXECUTE FUNCTION public.fn_calendar_dedupe_event_rsvp();

COMMENT ON FUNCTION public.fn_event_participation_to_calendar() IS
  'VTID-04321: global_event_participants attending -> calendar_events row (community_rsvp / community_event); leaving cancels it.';
COMMENT ON FUNCTION public.fn_calendar_dedupe_event_rsvp() IS
  'VTID-04321: a client-written calendar row for a meetup replaces the trigger-written one, so a join never shows twice.';
