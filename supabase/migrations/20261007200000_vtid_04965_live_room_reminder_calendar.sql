-- VTID-04965 — tapping "Erinnern" on a scheduled Live Room puts it in the
-- member's Maxina calendar.
--
-- "Erinnern" writes a live_stream_subscribers row (and a personal reminder),
-- but nothing wrote calendar_events, so a room the member asked to be
-- reminded about never appeared in the calendar. Community events solved the
-- same gap with a database trigger (VTID-04321/04915); client writes were
-- removed on purpose, so this is a trigger too:
--   * subscribe (insert)  -> one calendar row, source_type 'live_room',
--     source_ref (stream id, 'live_room'); only for a pending room that has
--     not started yet; a cancelled row is revived, a live one is left alone.
--   * unsubscribe (delete) -> the live row is cancelled.
--   * backfill: members already subscribed to a pending, future room get
--     their row, except registered test/service accounts.
-- 'live_room' is already allowed by valid_source_type (VTID-04331).
-- Idempotent: safe to run twice.

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
      DO UPDATE SET status = 'confirmed', updated_at = now()
        WHERE public.calendar_events.status = 'cancelled';
    END IF;
    RETURN NEW;
  END IF;

  -- DELETE: the member turned the reminder off.
  UPDATE public.calendar_events c
     SET status = 'cancelled', updated_at = now()
   WHERE c.user_id = OLD.user_id
     AND c.status <> 'cancelled'
     AND c.source_type = 'live_room'
     AND c.source_ref_type = 'live_room'
     AND c.source_ref_id = OLD.stream_id::text;
  RETURN OLD;
END;
$function$;

DROP TRIGGER IF EXISTS trg_live_stream_subscription_calendar ON public.live_stream_subscribers;
CREATE TRIGGER trg_live_stream_subscription_calendar
  AFTER INSERT OR DELETE ON public.live_stream_subscribers
  FOR EACH ROW EXECUTE FUNCTION public.fn_live_stream_subscription_to_calendar();

COMMENT ON FUNCTION public.fn_live_stream_subscription_to_calendar() IS
  'VTID-04965: live_stream_subscribers insert -> calendar_events row (live_room) for a pending, future room; delete cancels it.';

-- One-time backfill for reminders set before this trigger existed.
INSERT INTO public.calendar_events (
  user_id, title, description, start_time, end_time, location,
  event_type, source_type, source_ref_id, source_ref_type,
  status, role_context, metadata
)
SELECT s.user_id,
       COALESCE(NULLIF(l.title, ''), 'Live Room'),
       l.description,
       l.scheduled_for,
       l.scheduled_for + make_interval(mins => COALESCE(NULLIF(l.duration_minutes, 0), 60)),
       'Virtual', 'community', 'live_room', s.stream_id::text, 'live_room',
       'confirmed', 'community', jsonb_build_object('live_room_id', s.stream_id::text)
  FROM public.live_stream_subscribers s
  JOIN public.community_live_streams l ON l.id = s.stream_id
 WHERE l.status = 'pending'
   AND l.scheduled_for IS NOT NULL
   AND l.scheduled_for > now()
   AND NOT EXISTS (SELECT 1 FROM public.service_bot_accounts b WHERE b.user_id = s.user_id)
   AND NOT EXISTS (SELECT 1 FROM public.notification_test_actors t WHERE t.user_id = s.user_id)
ON CONFLICT (user_id, source_ref_id, source_ref_type) WHERE source_ref_id IS NOT NULL DO NOTHING;

-- Trigger functions run only through the trigger, never as a client RPC.
REVOKE ALL ON FUNCTION public.fn_live_stream_subscription_to_calendar() FROM PUBLIC, anon, authenticated;
