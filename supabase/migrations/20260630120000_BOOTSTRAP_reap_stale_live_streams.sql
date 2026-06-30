-- =============================================================================
-- BOOTSTRAP · Reap stale "live" rooms/streams (recurring pg_cron job)
-- =============================================================================
-- Bug: a Live Room that already took place (e.g. yesterday) keeps showing in
-- the Live Rooms listing and the room card still says "LIVE NOW".
--
-- Root cause: `community_live_streams.status` (and the backing `live_rooms` /
-- `live_room_sessions` rows) is only ever flipped to `ended` when the host
-- explicitly ends the room via the gateway `/live/rooms/:id/end` route. If the
-- host instead just closes the app or loses connection, nothing transitions the
-- state — the row stays `live` forever. The frontend treats `status='live'` as
-- "LIVE NOW" with no end-time check, so the dead room is advertised as live.
--
-- The existing `20260215000000_cleanup_stuck_live_sessions.sql` fixed this once,
-- but it is a ONE-TIME migration — new orphans accumulate after it ran. This
-- migration makes the cleanup RECURRING via pg_cron, mirroring that logic but
-- bounded by a max-session window.
--
-- Threshold: a stream/room "live" longer than `p_max_hours` (default 4h) is
-- treated as orphaned. Keep this in sync with `MAX_LIVE_STREAM_DURATION_MS`
-- in the frontend (`vitana-v1/src/hooks/useLiveStreams.ts`), which applies the
-- same guard client-side so the UI never shows a stale room even between runs.
--
-- pg_cron schema: cron.schedule(job_name, schedule, command).
-- Idempotency: cron.unschedule is called first to allow re-runs; the function
-- itself is safe to run repeatedly (only touches still-stuck rows).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- -----------------------------------------------------------------------------
-- 1. Reaper function: end live rooms/streams orphaned past the max session window
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_reap_stale_live_streams(p_max_hours integer DEFAULT 4)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cutoff           timestamptz := now() - make_interval(hours => p_max_hours);
  v_ended_streams    bigint := 0;
  v_ended_sessions   bigint := 0;
  v_reset_rooms      bigint := 0;
BEGIN
  -- A. End community_live_streams stuck in 'live' past the window. Use
  --    started_at when present, else created_at (a 'live' row with neither is
  --    itself orphaned and should be reaped — COALESCE keeps it in range when
  --    created_at is old).
  UPDATE public.community_live_streams
     SET status   = 'ended',
         ended_at = COALESCE(ended_at, now())
   WHERE status = 'live'
     AND COALESCE(started_at, created_at) < v_cutoff;
  GET DIAGNOSTICS v_ended_streams = ROW_COUNT;

  -- B. End the matching live_room_sessions (non-terminal sessions whose start is
  --    older than the window). Keeps the session-management model consistent
  --    with the stream listing.
  UPDATE public.live_room_sessions
     SET status     = 'ended',
         ends_at    = COALESCE(ends_at, now()),
         updated_at = now()
   WHERE status NOT IN ('ended', 'cancelled')
     AND starts_at < v_cutoff;
  GET DIAGNOSTICS v_ended_sessions = ROW_COUNT;

  -- C. Set left_at on any attendance still marked present for those ended sessions.
  UPDATE public.live_room_attendance
     SET left_at = now()
   WHERE left_at IS NULL
     AND session_id IN (
       SELECT id FROM public.live_room_sessions WHERE status = 'ended'
     );

  -- D. Reset stuck rooms back to idle (live/lobby/scheduled rooms with no active
  --    session, untouched for longer than the window).
  UPDATE public.live_rooms
     SET status             = 'idle',
         current_session_id = NULL,
         host_present       = false,
         updated_at         = now()
   WHERE status IN ('live', 'lobby', 'scheduled')
     AND updated_at < v_cutoff
     AND (
       current_session_id IS NULL
       OR current_session_id IN (
         SELECT id FROM public.live_room_sessions WHERE status IN ('ended', 'cancelled')
       )
     );
  GET DIAGNOSTICS v_reset_rooms = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok',             true,
    'ended_streams',  v_ended_streams,
    'ended_sessions', v_ended_sessions,
    'reset_rooms',    v_reset_rooms,
    'cutoff',         v_cutoff,
    'ran_at',         now()
  );
END;
$$;

COMMENT ON FUNCTION public.fn_reap_stale_live_streams IS
  'BOOTSTRAP: recurring reaper that ends live rooms/streams/sessions orphaned in a non-terminal state past p_max_hours (default 4h). Prevents past Live Rooms from showing "LIVE NOW" indefinitely. Keep p_max_hours in sync with MAX_LIVE_STREAM_DURATION_MS in the frontend.';

GRANT EXECUTE ON FUNCTION public.fn_reap_stale_live_streams TO service_role;

-- -----------------------------------------------------------------------------
-- 2. Schedule the cron job (idempotent — unschedule first). Runs hourly so an
--    orphaned room is cleaned within ~1h of crossing the window.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  v_jobid bigint;
BEGIN
  FOR v_jobid IN
    SELECT jobid FROM cron.job WHERE jobname = 'reap_stale_live_streams'
  LOOP
    PERFORM cron.unschedule(v_jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'reap_stale_live_streams',
  '15 * * * *',                         -- hourly at :15
  $cron_reap$SELECT public.fn_reap_stale_live_streams();$cron_reap$
);

-- -----------------------------------------------------------------------------
-- 3. Run once immediately to clear the current backlog of stuck rooms.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.fn_reap_stale_live_streams();
  IF NOT (v_result->>'ok')::boolean THEN
    RAISE EXCEPTION 'fn_reap_stale_live_streams returned %', v_result;
  END IF;
  RAISE NOTICE 'reap_stale_live_streams initial run: ended_streams=%, ended_sessions=%, reset_rooms=%',
    v_result->>'ended_streams', v_result->>'ended_sessions', v_result->>'reset_rooms';
END $$;

-- -----------------------------------------------------------------------------
-- 4. Verification: cron job registered
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT COUNT(*) INTO v_count FROM cron.job WHERE jobname = 'reap_stale_live_streams';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'reap_stale_live_streams cron: expected 1 job registered, found %', v_count;
  END IF;
  RAISE NOTICE 'reap_stale_live_streams cron scheduled ✓ (hourly at :15)';
END $$;
