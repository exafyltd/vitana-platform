# Sparring round 3 — escalated

Session: `05c2a910-4ba9-4754-89b8-a22891c4d8a1` · plan hash `e2b4fdd3d1c23b57bc370556f0eaef0a761e4981023b7557386bf071243c734f`

## Summary

Round 3 review of the live-room-recurrence plan. Both R2-F1 and R2-F2 were accepted by the planner. R2-F1 (ROOM_NOT_IDLE blocker) is addressed: occurrence 0 goes through `live_room_create_session`, the rest use `live_room_series_insert_occurrence`. R2-F2 (single-session model) is addressed: Interface 6 adds `live_room_series_promote_next` and a missed-occurrence cancel. However, the promotion trigger frequency contradicts the materialiser frequency stated in Interface 3, and the initial creation path's window is unspecified. Two new findings raised.

## Findings

### R3-F1 [major]

Interface 3 says the materialiser 'runs one tick per hour' but Interface 6 says 'the materialiser tick (Interface 3) runs it for every room that has an active series, every 5 minutes'. A single worker cannot tick both hourly and every 5 minutes. If the materialiser truly runs hourly, promotion happens at most once per hour, meaning after a session ends the room sits idle with no linked next occurrence for up to 60 minutes — users would see an empty room with no upcoming session. If the whole worker runs every 5 minutes, the hourly claim in Interface 3 is wrong and the plan should say so (and justify the higher frequency for the materialisation pass, which is heavier).

- `exafyltd/vitana-platform:supabase/migrations/20260210100000_vtid_01228_live_room_session_mgmt.sql:469` — -- Reset room to idle
    UPDATE public.live_rooms
    SET status = 'idle',
        current_session_id = NULL,
        host_present = false,
        updated_at = NOW()
    WHERE id = p_room_id;

Suggestion: Specify two separate intervals in the worker: a fast loop (e.g. every 5 minutes) that only runs `live_room_series_promote_next` for rooms with an active series, and a slow loop (hourly) that materialises new occurrence rows. Alternatively, call `live_room_series_promote_next` synchronously inside `live_room_end_session` so promotion is instant and the materialiser only needs the hourly tick for row creation. State whichever design you pick explicitly in both Interface 3 and Interface 6.

### R3-F2 [minor]

Interface 2 says 'The gateway expands the occurrences from starts_at with expandOccurrences and creates the series row' but does not state the window used for that expansion. `expandOccurrences` requires a `{ from, to }` window (calendar-recurrence.ts:118). For a weekly series with count=52 (~1 year), expanding with a 12-month window creates all 52 session rows in a single POST, while expanding with the 8-week rolling window creates only ~8 rows and leaves the rest for the materialiser. The plan should be explicit about which approach is used at creation time, so the implementer and the materialiser agree on who creates which rows.

- `exafyltd/vitana-platform:services/gateway/src/services/calendar-recurrence.ts:118` — export function expandOccurrences(
  event: ExpandInput,
  window: { from: string; to: string },
  fallbackTz: string,
  limit = 500,
): Occurrence[] {
  const rule = parseRRule(event.rrule);
  const dtstart = Date.parse(event.start_time);
  if (!rule || Number.isNaN(dtstart)) return [];
  const end0 = event.end_time ? Date.parse(event.end_time) : NaN;
  const duration = Number.isNaN(end0) || end0 < dtstart ? 0 : end0 - dtstart;
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return [];

Suggestion: State in Interface 2 that the initial POST uses the same 8-week window as the materialiser (e.g. `{ from: now, to: now + 8 weeks }`), and that occurrences beyond this window are created by the materialiser. This ensures the POST is fast, the materialiser is the single owner of future-window rows, and idempotency keys prevent duplicates at the boundary.
