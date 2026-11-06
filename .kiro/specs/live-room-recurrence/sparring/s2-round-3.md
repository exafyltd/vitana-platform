# Sparring round 3 — escalated

Session: `1e9e89c5-00cb-4229-9e27-4c64ae409feb` · plan hash `793a69d003fb0d8672dc5873d94b5f5bd9f59533b85595d9dd6371c2143bdb7f`

## Summary

Round 3 review. The R2-F1 fix (occurrence 0 series linkage) is adequately addressed in the revised plan text and test coverage. All verified premises hold. One new finding: the cancel-series path does not reset the room when the current session is part of the cancelled series, leaving the room stuck in `scheduled` status.

## Findings

### R3-F1 [major]

Cancel-series leaves the room stuck in `scheduled` status when its `current_session_id` points to a cancelled occurrence. The plan says `POST .../sessions/series/cancel` sets `status = 'cancelled'` on the series and on its scheduled occurrences. But the room's `current_session_id` may point to one of those occurrences (e.g., occurrence 0 or the most recently promoted one) while the room itself is in `scheduled` status. The plan's cancel path directly updates `live_room_sessions` rows, bypassing `live_room_end_session` (the only function that resets a room to idle, at line 469-475) and `live_room_transition_status`. After the cancel, the room remains `status = 'scheduled'` with `current_session_id` pointing to a now-cancelled session. The promotion loop only acts on idle rooms (Interface 6: 'When the room is idle'), so no future session from any series will be promoted. The room is permanently stuck unless the host manually triggers an end-session call.

- `exafyltd/vitana-platform:supabase/migrations/20260210100000_vtid_01228_live_room_session_mgmt.sql:469` —     -- Reset room to idle
    UPDATE public.live_rooms
    SET status = 'idle',
        current_session_id = NULL,
        host_present = false,
        updated_at = NOW()
    WHERE id = p_room_id;

    RETURN jsonb_build_object('ok', true, 'ended_session_id', v_room.current_session_id);
- `exafyltd/vitana-platform:supabase/migrations/20260210100000_vtid_01228_live_room_session_mgmt.sql:440` — -- 8c. End session (reset room to idle)
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
    IF v_room.status NOT IN ('live', 'lobby', 'scheduled') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'INVALID_STATE');
    END IF;

Suggestion: The cancel-series gateway handler must, after cancelling the series' scheduled occurrences, check whether the room's `current_session_id` was among the cancelled rows. If so, it must reset the room to idle (`status = 'idle'`, `current_session_id = NULL`, `host_present = false`) — the same effect as `live_room_end_session` lines 469-475, but done via a service_role UPDATE since the cancel endpoint runs as service_role anyway. Add this step to the plan and add a test: cancel a series whose occurrence 0 is the room's current scheduled session → assert the room is idle and `current_session_id` is NULL afterwards.

## Acknowledgements of earlier responses

- R2-F1: acknowledged — Accepted and adequately addressed. The plan now specifies that the gateway sets series_id and series_index = 0 via a service_role UPDATE after live_room_create_session returns, with clear idempotency reasoning (the idempotency key returns the same row, the UPDATE is idempotent). A corresponding test is listed: 'occurrence 0 has series_id and series_index = 0; series edit and cancel reach occurrence 0.'
