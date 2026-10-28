-- VTID-04976 — a live room's calendar entries follow the room.
--
-- VTID-04965 put a room in the member's calendar on "Erinnern", but only
-- subscribe/unsubscribe wrote the calendar: a host who rescheduled, renamed,
-- cancelled or deleted a room left every subscriber's entry on the old time,
-- and the host got no entry of their own unless they also tapped Erinnern.
--
--   * community_live_streams INSERT (pending, future): one host entry,
--     metadata.host=true. It is the SAME row (user, stream) a subscription by
--     the host would write: if it already exists only host=true is merged in.
--   * UPDATE of scheduled_for / duration_minutes / title / description:
--     every live entry of that stream moves (set-based). status 'cancelled' or
--     scheduled_for NULL cancels them. Status is a WHITELIST: only 'cancelled'
--     cancels; 'live' / 'ended' (or any future value) leave the entries
--     alone — the room has started, the entry is history. Cancelled entries
--     are never revived by an UPDATE.
--   * DELETE: every live entry is cancelled.
--   * Un-notify (subscriber DELETE) leaves the HOST's entry alone: the host's
--     relationship to the room is created_by, not the subscription.
--   * Re-notify after a reschedule revives the entry AT THE CURRENT TIME (the
--     old revive kept the time the entry had when it was cancelled).
--   * One-time backfill: hosts of pending, future rooms get their entry.
-- Test/service accounts are never given an entry. Idempotent.
-- impact-allow-solo-migration: triggers + backfill on existing tables.

-- 1. Subscriber trigger: host-safe DELETE, revive at the current time.
CREATE OR REPLACE FUNCTION public.fn_live_stream_subscription_to_calendar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_stream public.community_live_streams%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO v_stream FROM public.community_live_streams WHERE id = NEW.stream_id;
    IF FOUND
       AND v_stream.status = 'pending'
       AND v_stream.scheduled_for IS NOT NULL
       AND v_stream.scheduled_for > now()
       AND NOT EXISTS (SELECT 1 FROM public.service_bot_accounts WHERE user_id = NEW.user_id)
       AND NOT EXISTS (SELECT 1 FROM public.notification_test_actors WHERE user_id = NEW.user_id)
    THEN
      INSERT INTO public.calendar_events (
        user_id, title, description, start_time, end_time, location,
        event_type, source_type, source_ref_id, source_ref_type,
        status, role_context, metadata
      ) VALUES (
        NEW.user_id,
        COALESCE(NULLIF(v_stream.title, ''), 'Live Room'),
        v_stream.description,
        v_stream.scheduled_for,
        v_stream.scheduled_for + make_interval(mins => COALESCE(NULLIF(v_stream.duration_minutes, 0), 60)),
        'Virtual',
        'community',
        'live_room',
        NEW.stream_id::text,
        'live_room',
        'confirmed',
        'community',
        jsonb_build_object('live_room_id', NEW.stream_id::text)
      )
      ON CONFLICT (user_id, source_ref_id, source_ref_type) WHERE source_ref_id IS NOT NULL
      DO UPDATE SET status = 'confirmed',
                    title = EXCLUDED.title,
                    description = EXCLUDED.description,
                    start_time = EXCLUDED.start_time,
                    end_time = EXCLUDED.end_time,
                    updated_at = now()
        WHERE public.calendar_events.status = 'cancelled';
    END IF;
    RETURN NEW;
  END IF;

  -- DELETE: the member turned the reminder off. The host's own entry stays.
  UPDATE public.calendar_events c
     SET status = 'cancelled', updated_at = now()
   WHERE c.user_id = OLD.user_id
     AND c.status <> 'cancelled'
     AND c.source_type = 'live_room'
     AND c.source_ref_type = 'live_room'
     AND c.source_ref_id = OLD.stream_id::text
     AND COALESCE(c.metadata->>'host', '') <> 'true';
  RETURN OLD;
END;
$function$;

-- 2. The room itself: host entry, follow edits, cancel.
CREATE OR REPLACE FUNCTION public.fn_live_stream_to_calendar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.service_bot_accounts WHERE user_id = NEW.created_by)
       AND NOT EXISTS (SELECT 1 FROM public.notification_test_actors WHERE user_id = NEW.created_by)
    THEN
      INSERT INTO public.calendar_events (
        user_id, title, description, start_time, end_time, location,
        event_type, source_type, source_ref_id, source_ref_type,
        status, role_context, metadata
      ) VALUES (
        NEW.created_by,
        COALESCE(NULLIF(NEW.title, ''), 'Live Room'),
        NEW.description,
        NEW.scheduled_for,
        NEW.scheduled_for + make_interval(mins => COALESCE(NULLIF(NEW.duration_minutes, 0), 60)),
        'Virtual',
        'community',
        'live_room',
        NEW.id::text,
        'live_room',
        'confirmed',
        'community',
        jsonb_build_object('live_room_id', NEW.id::text, 'host', true)
      )
      ON CONFLICT (user_id, source_ref_id, source_ref_type) WHERE source_ref_id IS NOT NULL
      DO UPDATE SET metadata = public.calendar_events.metadata || jsonb_build_object('host', true);
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    UPDATE public.calendar_events c
       SET status = 'cancelled', updated_at = now()
     WHERE c.source_type = 'live_room'
       AND c.source_ref_type = 'live_room'
       AND c.source_ref_id = OLD.id::text
       AND c.status <> 'cancelled';
    RETURN OLD;
  END IF;

  -- UPDATE. Whitelist: only 'cancelled' (or no date any more) cancels.
  IF NEW.status = 'cancelled' OR NEW.scheduled_for IS NULL THEN
    UPDATE public.calendar_events c
       SET status = 'cancelled', updated_at = now()
     WHERE c.source_type = 'live_room'
       AND c.source_ref_type = 'live_room'
       AND c.source_ref_id = NEW.id::text
       AND c.status <> 'cancelled';
  ELSIF NEW.status = 'pending' THEN
    UPDATE public.calendar_events c
       SET start_time = NEW.scheduled_for,
           end_time = NEW.scheduled_for + make_interval(mins => COALESCE(NULLIF(NEW.duration_minutes, 0), 60)),
           title = COALESCE(NULLIF(NEW.title, ''), 'Live Room'),
           description = NEW.description,
           updated_at = now()
     WHERE c.source_type = 'live_room'
       AND c.source_ref_type = 'live_room'
       AND c.source_ref_id = NEW.id::text
       AND c.status <> 'cancelled';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_live_stream_host_calendar ON public.community_live_streams;
CREATE TRIGGER trg_live_stream_host_calendar
  AFTER INSERT ON public.community_live_streams
  FOR EACH ROW
  WHEN (NEW.status = 'pending' AND NEW.scheduled_for IS NOT NULL AND NEW.scheduled_for > now())
  EXECUTE FUNCTION public.fn_live_stream_to_calendar();

DROP TRIGGER IF EXISTS trg_live_stream_change_calendar ON public.community_live_streams;
CREATE TRIGGER trg_live_stream_change_calendar
  AFTER UPDATE OF scheduled_for, duration_minutes, title, description, status ON public.community_live_streams
  FOR EACH ROW
  WHEN (OLD.scheduled_for IS DISTINCT FROM NEW.scheduled_for
     OR OLD.duration_minutes IS DISTINCT FROM NEW.duration_minutes
     OR OLD.title IS DISTINCT FROM NEW.title
     OR OLD.description IS DISTINCT FROM NEW.description
     OR OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.fn_live_stream_to_calendar();

DROP TRIGGER IF EXISTS trg_live_stream_delete_calendar ON public.community_live_streams;
CREATE TRIGGER trg_live_stream_delete_calendar
  AFTER DELETE ON public.community_live_streams
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_live_stream_to_calendar();

COMMENT ON FUNCTION public.fn_live_stream_to_calendar() IS
  'VTID-04976: community_live_streams -> calendar_events (host entry on create; edits move every live entry; cancelled/deleted/no-date cancels).';

-- Trigger functions run only through their triggers, never as a client RPC.
REVOKE ALL ON FUNCTION public.fn_live_stream_to_calendar() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_live_stream_subscription_to_calendar() FROM PUBLIC, anon, authenticated;

-- 3. One-time host backfill (pending, future rooms). An existing row (a host
-- who tapped Erinnern, possibly un-notified under the old rule) gets host=true,
-- the room's current time, and is revived if it had been cancelled.
INSERT INTO public.calendar_events (
  user_id, title, description, start_time, end_time, location,
  event_type, source_type, source_ref_id, source_ref_type,
  status, role_context, metadata
)
SELECT l.created_by,
       COALESCE(NULLIF(l.title, ''), 'Live Room'),
       l.description,
       l.scheduled_for,
       l.scheduled_for + make_interval(mins => COALESCE(NULLIF(l.duration_minutes, 0), 60)),
       'Virtual', 'community', 'live_room', l.id::text, 'live_room',
       'confirmed', 'community', jsonb_build_object('live_room_id', l.id::text, 'host', true)
  FROM public.community_live_streams l
 WHERE l.status = 'pending'
   AND l.scheduled_for IS NOT NULL
   AND l.scheduled_for > now()
   AND l.created_by IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.service_bot_accounts b WHERE b.user_id = l.created_by)
   AND NOT EXISTS (SELECT 1 FROM public.notification_test_actors t WHERE t.user_id = l.created_by)
ON CONFLICT (user_id, source_ref_id, source_ref_type) WHERE source_ref_id IS NOT NULL
DO UPDATE SET metadata = public.calendar_events.metadata || jsonb_build_object('host', true),
              status = CASE WHEN public.calendar_events.status = 'cancelled' THEN 'confirmed' ELSE public.calendar_events.status END,
              start_time = EXCLUDED.start_time,
              end_time = EXCLUDED.end_time,
              title = EXCLUDED.title,
              description = EXCLUDED.description,
              updated_at = now();
