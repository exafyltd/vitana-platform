# Sparring round 2 — in_progress

Session: `05c2a910-4ba9-4754-89b8-a22891c4d8a1` · plan hash `0da7d94af7a006ae8b0be89bc56394d50cc5e1c2118551df861a8d8797c0d751`

## Summary

The three R1 accepted findings were all addressed in the revision. However, the fix for R1-F1 only covers the rolling-window materialiser (Interface 3) — the initial creation path (Interface 2) still claims to create multiple sessions "through the existing `live_room_create_session` path", which enforces a ROOM_NOT_IDLE guard and mutates `current_session_id`. This means it cannot create more than one session per room. The existing room model is fundamentally single-session: one `current_session_id` per room, a state machine that cycles idle→scheduled→lobby→live→ended→idle. Multiple scheduled sessions break this model, and the plan doesn't address how the room state or `current_session_id` works with series.

## Findings

### R2-F1 [blocker]

Interface 2 says the initial creation creates 'one session per occurrence through the existing live_room_create_session path', but that RPC enforces ROOM_NOT_IDLE (line 321: `IF v_room.status != 'idle'`). After the first session is created, the RPC sets the room status to 'scheduled' (or 'live'/'lobby') and assigns `current_session_id` (lines 373-380). Every subsequent call for the same room fails with ROOM_NOT_IDLE. The plan also lists `live_room_create_session` under 'Unchanged'. A series with more than one occurrence cannot be created through this path.

- `exafyltd/vitana-platform:supabase/migrations/20260210100000_vtid_01228_live_room_session_mgmt.sql:320` — -- Room must be idle
    IF v_room.status != 'idle' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'ROOM_NOT_IDLE', 'message', 'Room already has an active session');
    END IF;
- `exafyltd/vitana-platform:supabase/migrations/20260210100000_vtid_01228_live_room_session_mgmt.sql:373` — UPDATE public.live_rooms
    SET current_session_id = v_session_id,
        status = v_initial_status,
        access_level = COALESCE(p_payload->>'access_level', 'public'),
        host_present = false,
        updated_at = NOW()
    WHERE id = p_room_id AND status = 'idle';

Suggestion: The initial creation must also use the new `live_room_series_insert_occurrence` SQL function (or an equivalent direct insert) for every occurrence except possibly the very first. Only the first (or nearest-upcoming) occurrence should be linked to the room via `current_session_id`. The plan must also specify how the room state machine interacts with series: when a session ends and the room resets to idle, how is the next occurrence promoted to `current_session_id`? (E.g., the auto-transition / checkAutoTransitions path picks the next scheduled occurrence and sets it.)

### R2-F2 [major]

The existing room model is single-session: `live_rooms.current_session_id` is a single FK (line 96-98), the state machine cycles idle→scheduled→…→ended→idle (room-state-machine.ts lines 76-139), and `live_room_end_session` resets the room to idle with `current_session_id = NULL` (lines 470-475). With a series, multiple 'scheduled' sessions will exist on the same room simultaneously, but only one can be `current_session_id`. The plan never specifies how `current_session_id` is managed for series (which occurrence is 'current'?) or how the room transitions from one occurrence to the next (ended→idle→scheduled for the next occurrence). Without this design, the lobby, join gate, enter/exit and all paths that read `current_session_id` will not find future scheduled occurrences.

- `exafyltd/vitana-platform:supabase/migrations/20260210100000_vtid_01228_live_room_session_mgmt.sql:95` — ALTER TABLE public.live_rooms ADD CONSTRAINT fk_live_rooms_current_session
    FOREIGN KEY (current_session_id) REFERENCES public.live_room_sessions(id)
    ON DELETE SET NULL;
- `exafyltd/vitana-platform:supabase/migrations/20260210100000_vtid_01228_live_room_session_mgmt.sql:469` — UPDATE public.live_rooms
    SET status = 'idle',
        current_session_id = NULL,
        host_present = false,
        updated_at = NOW()
    WHERE id = p_room_id;

    RETURN jsonb_build_object('ok', true, 'ended_session_id', v_room.current_session_id);
- `exafyltd/vitana-platform:services/gateway/src/services/room-state-machine.ts:76` — states: {
      idle: { on: { GO_LIVE: [...] } },
      scheduled: { on: { OPEN_LOBBY: { target: 'lobby' }, CANCEL: { target: 'cancelled' } } },
      ...
      ended: { on: { RESET: { target: 'idle' } } },
      cancelled: { on: { RESET: { target: 'idle' } } },
    }

Suggestion: Add a 'next-occurrence promotion' mechanism: when a session ends (or is cancelled) and the room resets to idle, the system picks the nearest-upcoming scheduled occurrence from the same room and sets it as `current_session_id` + updates the room status to 'scheduled'. This could live in the `live_room_end_session` RPC, in the auto-transition check, or in the materialiser. Specify this path, its trigger, and test it.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
