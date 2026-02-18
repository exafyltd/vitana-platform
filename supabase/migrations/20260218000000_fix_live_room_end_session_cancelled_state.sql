-- Fix: live_room_end_session must accept 'cancelled' status
--
-- BUG: cancelSession() transitions room to 'cancelled' first, then calls
-- live_room_end_session to reset to idle. But live_room_end_session only
-- accepted ('live', 'lobby', 'scheduled'), so the reset silently failed
-- and rooms got permanently stuck in 'cancelled' state.
--
-- Also accept 'ended' for defensive robustness (same reset-to-idle intent).

CREATE OR REPLACE FUNCTION public.live_room_end_session(p_room_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_room RECORD;
BEGIN
  SELECT * INTO v_room FROM public.live_rooms WHERE id = p_room_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ROOM_NOT_FOUND');
  END IF;
  IF v_room.host_user_id != auth.uid() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_HOST');
  END IF;
  IF v_room.status NOT IN ('live', 'lobby', 'scheduled', 'cancelled', 'ended') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_STATE');
  END IF;

  -- End the session
  IF v_room.current_session_id IS NOT NULL THEN
    UPDATE public.live_room_sessions
    SET status = 'ended', ends_at = COALESCE(ends_at, NOW()), updated_at = NOW()
    WHERE id = v_room.current_session_id;

    -- Set left_at on all active attendance
    UPDATE public.live_room_attendance
    SET left_at = NOW()
    WHERE session_id = v_room.current_session_id AND left_at IS NULL;
  END IF;

  -- Reset room to idle
  UPDATE public.live_rooms
  SET status = 'idle',
      current_session_id = NULL,
      host_present = false,
      updated_at = NOW()
  WHERE id = p_room_id;

  RETURN jsonb_build_object('ok', true, 'ended_session_id', v_room.current_session_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Also fix any rooms currently stuck in 'cancelled' state
UPDATE public.live_rooms
SET status = 'idle',
    current_session_id = NULL,
    host_present = false,
    updated_at = NOW()
WHERE status = 'cancelled';
