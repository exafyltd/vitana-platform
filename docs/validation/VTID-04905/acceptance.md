# VTID-04905 — Live Rooms: enter/exit, lifecycle, notifications (LR-A2)

AC-1 POST /rooms/:id/enter: 409 NOT_LIVE without a live/lobby session; host entering a scheduled session starts it; paid without grant 402; returns url + token + counts; records attendance and updates viewer_count.
TEST: services/gateway/test/vtid-04905-live-enter-exit.test.ts — "POST /rooms/:id/enter — access matrix"

AC-2 POST /rooms/:id/exit closes attendance for the current session only and updates viewer_count.
TEST: services/gateway/test/vtid-04905-live-enter-exit.test.ts — "POST /rooms/:id/exit"

AC-3 The listing follows a transition only when the host-only RPC succeeded, in both directions.
TEST: services/gateway/test/vtid-04905-live-enter-exit.test.ts — "checkAutoTransitions — listing follows only successful transitions"

AC-4 /sessions sets ends_at (start + duration, default 60) and validates stream_type (audio|video).
TEST: services/gateway/test/vtid-04905-live-enter-exit.test.ts — "POST /rooms/:id/sessions — lifecycle fields"

AC-5 Notifications use real columns (live_rooms.tenant_id, host_user_id, live_room_attendance), link to /comm/live-rooms/<id>/view and use catalog keys.
TEST: services/gateway/test/vtid-04905-live-enter-exit.test.ts — "live-repository — real column names (B9)", "POST /rooms/:id/end — summary notification"
