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
--
-- impact-allow-solo-migration: self-contained pg_cron cleanup job — it runs
-- autonomously in the DB and needs no gateway/worker code to be usable. The
-- only code counterpart is the frontend staleness guard, which lives in the
-- separate exafyltd/vitana-v1 repo (PR on the same branch).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- -----------------------------------------------------------------------------
-- 0. Ensure the planned-duration column exists.
-- -----------------------------------------------------------------------------
-- `community_live_streams.duration_minutes` is owned by vitana-v1's migration
-- set, but both repos deploy to the SAME database via independent pipelines with
-- no guaranteed ordering. The reaper below references the column and the step-3
-- initial run executes immediately, so if this migration applies before v1's,
-- the run would raise undefined_column and abort. Add it idempotently here too
-- (and the gateway PostgREST insert depends on it existing). Safe no-op when
-- v1's migration already added it.
ALTER TABLE public.community_live_streams
  ADD COLUMN IF NOT EXISTS duration_minutes integer;

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
  v_grace            interval := interval '15 minutes';  -- matches frontend guard
  v_ended_streams    bigint := 0;
  v_ended_sessions   bigint := 0;
  v_reset_rooms      bigint := 0;
BEGIN
  -- A. End community_live_streams that are finished. A room is finished when it
  --    is past its planned end (start + duration_minutes + grace). Rooms with no
  --    duration (legacy / unknown) fall back to the fixed max-session cap
  --    (p_max_hours). Start = started_at, else scheduled_for, else created_at; a
  --    'live' row with none of those is orphaned and reaped via the cap branch.
  UPDATE public.community_live_streams
     SET status   = 'ended',
         ended_at = COALESCE(ended_at, now())
   WHERE status = 'live'
     AND (
       (duration_minutes IS NOT NULL AND duration_minutes > 0
         AND COALESCE(started_at, scheduled_for, created_at)
             + make_interval(mins => duration_minutes) + v_grace < now())
       OR
       ((duration_minutes IS NULL OR duration_minutes <= 0)
         AND COALESCE(started_at, scheduled_for, created_at) < v_cutoff)
     );
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

  -- D. Reset stuck rooms back to idle so the host can start a new room. A room
  --    whose current_session_id points to an ended/cancelled session is reset
  --    immediately, regardless of updated_at — step B may have just ended that
  --    session, and live_room_create_session rejects any non-idle room, so a
  --    recent updated_at (host presence, another room write) must NOT keep the
  --    room stuck. The updated_at < cutoff guard is kept ONLY for the ambiguous
  --    "no current session" case, to avoid clobbering a room mid-creation.
  UPDATE public.live_rooms
     SET status             = 'idle',
         current_session_id = NULL,
         host_present       = false,
         updated_at         = now()
   WHERE status IN ('live', 'lobby', 'scheduled')
     AND (
       current_session_id IN (
         SELECT id FROM public.live_room_sessions WHERE status IN ('ended', 'cancelled')
       )
       OR (current_session_id IS NULL AND updated_at < v_cutoff)
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
