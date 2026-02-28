-- =============================================================================
-- Cleanup Stuck Live Sessions (one-time fix)
--
-- This migration fixes rooms and sessions stuck in non-idle states by:
-- 1. Ending all stuck sessions (lobby/scheduled with old timestamps)
-- 2. Resetting stuck rooms to idle
-- 3. Clearing current_session_id on stuck rooms
-- 4. Syncing community_live_streams to ended state
--
-- Safe to run multiple times (idempotent).
-- =============================================================================

BEGIN;

-- Step 1: End stuck sessions (lobby/scheduled older than 2 hours)
UPDATE public.live_room_sessions
SET
  status = 'ended',
  ends_at = COALESCE(ends_at, NOW()),
  updated_at = NOW()
WHERE
  status IN ('lobby', 'scheduled')
  AND starts_at < NOW() - INTERVAL '2 hours'
  AND (ends_at IS NULL OR ends_at < NOW());

-- Get count for logging
DO $$
DECLARE
  v_ended_sessions INT;
BEGIN
  GET DIAGNOSTICS v_ended_sessions = ROW_COUNT;
  RAISE NOTICE 'Ended % stuck sessions', v_ended_sessions;
END $$;

-- Step 2: Set left_at on all active attendance for ended sessions
UPDATE public.live_room_attendance
SET left_at = NOW()
WHERE
  session_id IN (
    SELECT id
    FROM public.live_room_sessions
    WHERE status = 'ended'
  )
  AND left_at IS NULL;

-- Step 3: Reset stuck rooms to idle (rooms with ended/null sessions but status != idle)
UPDATE public.live_rooms
SET
  status = 'idle',
  current_session_id = NULL,
  host_present = false,
  updated_at = NOW()
WHERE
  status IN ('lobby', 'scheduled', 'live')
  AND (
    -- No current session
    current_session_id IS NULL
    OR
    -- Current session is ended
    current_session_id IN (
      SELECT id
      FROM public.live_room_sessions
      WHERE status IN ('ended', 'cancelled')
    )
  );

-- Get count for logging
DO $$
DECLARE
  v_reset_rooms INT;
BEGIN
  GET DIAGNOSTICS v_reset_rooms = ROW_COUNT;
  RAISE NOTICE 'Reset % stuck rooms to idle', v_reset_rooms;
END $$;

-- Step 4: Sync community_live_streams to ended state for stuck rooms
UPDATE public.community_live_streams
SET
  status = 'ended',
  ended_at = COALESCE(ended_at, NOW())
WHERE
  status IN ('live', 'pending')
  AND (
    -- No matching live room
    id NOT IN (SELECT id FROM public.live_rooms WHERE status IN ('live', 'lobby', 'scheduled'))
    OR
    -- Scheduled_for is in the past and never went live
    (status = 'pending' AND scheduled_for IS NOT NULL AND scheduled_for < NOW() - INTERVAL '2 hours')
  );

-- Get count for logging
DO $$
DECLARE
  v_synced_streams INT;
BEGIN
  GET DIAGNOSTICS v_synced_streams = ROW_COUNT;
  RAISE NOTICE 'Synced % stuck streams to ended in community_live_streams', v_synced_streams;
END $$;

COMMIT;

-- Post-migration verification
DO $$
DECLARE
  v_stuck_rooms INT;
  v_stuck_sessions INT;
BEGIN
  SELECT COUNT(*) INTO v_stuck_rooms
  FROM public.live_rooms
  WHERE status IN ('lobby', 'scheduled', 'live')
    AND (current_session_id IS NULL OR current_session_id IN (
      SELECT id FROM public.live_room_sessions WHERE status IN ('ended', 'cancelled')
    ));

  SELECT COUNT(*) INTO v_stuck_sessions
  FROM public.live_room_sessions
  WHERE status IN ('lobby', 'scheduled')
    AND starts_at < NOW() - INTERVAL '2 hours';

  IF v_stuck_rooms > 0 OR v_stuck_sessions > 0 THEN
    RAISE WARNING 'Still found % stuck rooms and % stuck sessions after cleanup', v_stuck_rooms, v_stuck_sessions;
  ELSE
    RAISE NOTICE 'Cleanup successful: No stuck rooms or sessions found';
  END IF;
END $$;
