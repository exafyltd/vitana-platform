# Sparring round 1 — in_progress

Session: `1e9e89c5-00cb-4229-9e27-4c64ae409feb` · plan hash `5f132b1926568321dd2f780bca70782a4aff85c16659d2ea2c78be88ce70f0aa`

## Summary

The plan's premises about the existing codebase are accurate. The main structural gap is in the `live_room_series` table schema: it lacks the session-level template fields (title, topic_keys, access_level, metadata, co-host list) that the materialiser would need to create correct occurrence rows. The `expandOccurrences` reuse, calendar trigger propagation, idle-reset flow, and idempotency-key design are all sound.

## Findings

### R1-F1 [major]

The `live_room_series` table schema omits session-level template fields needed by materialisation and series-scope edits. The schema lists only: id, tenant_id, room_id, host_user_id, rrule, time_zone, starts_at_first, until_at, max_occurrences, status, created_at. But `live_room_series_insert_occurrence` 'reads host, tenant, rule and time from the live_room_series row' and creates a session row from it. Since the series row has no session_title, topic_keys, access_level, auto_admit, lobby_buffer_minutes, max_participants, or metadata (stream_type), every materialised occurrence would get NULLs / column defaults instead of the values the host chose at creation. The same gap affects co-hosts: the plan says 'the co-host list is copied to each occurrence at creation' but neither the series schema nor the SQL function specification includes co-host storage or copying logic. A `scope: "series"` edit that changes title/co-hosts would update existing scheduled rows but future materialised occurrences would still be bare.

- `exafyltd/vitana-platform:supabase/migrations/20260210100000_vtid_01228_live_room_session_mgmt.sql:48` — CREATE TABLE IF NOT EXISTS public.live_room_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  room_id UUID NOT NULL REFERENCES public.live_rooms(id) ON DELETE CASCADE,
  session_title TEXT,
  topic_keys TEXT[] DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'lobby', 'live', 'ended', 'cancelled')),
  access_level TEXT DEFAULT 'public'
    CHECK (access_level IN ('public', 'group')),
  starts_at TIMESTAMPTZ NOT NULL,
  ...  metadata JSONB DEFAULT '{}'::JSONB,
  idempotency_key TEXT,

Suggestion: Add session-template columns to `live_room_series`: at minimum `session_title`, `topic_keys`, `access_level`, `auto_admit`, `lobby_buffer_minutes`, `max_participants`, `metadata` (or a single `session_defaults JSONB`). Add a `co_host_user_ids UUID[]` column (or a join table). Have `live_room_series_insert_occurrence` read these values when creating the session row. On a `scope: "series"` edit, update both the series template and existing scheduled occurrences so the materialiser picks up the new values for future rows.

### R1-F2 [major]

The promotion function `live_room_series_promote_next` has a TOCTOU window: it reads the room's status as 'idle', picks the next occurrence, then UPDATEs `current_session_id`. On Cloud Run with multiple instances running the 5-minute promotion loop, two instances can both read the room as idle and both attempt to promote. While the plan says it has 'in-process locks', those only prevent overlap within a single instance. The plan does not specify any row-level or advisory lock in the SQL function. Although the practical risk is low (both would pick the same occurrence, making the UPDATE idempotent), the function should be provably serialised so that a room transitioning through idle very quickly (e.g., a very short session) does not result in skipping an occurrence or double-promoting.

- `exafyltd/vitana-platform:supabase/migrations/20260210100000_vtid_01228_live_room_session_mgmt.sql:469` — -- Reset room to idle
    UPDATE public.live_rooms
    SET status = 'idle',
        current_session_id = NULL,
        host_present = false,
        updated_at = NOW()
    WHERE id = p_room_id;

    RETURN jsonb_build_object('ok', true, 'ended_session_id', v_room.current_session_id);
- `exafyltd/vitana-platform:services/gateway/src/index.ts:2394` — // VTID-01900: Longevity News Feed — background RSS fetcher
        try {
          const fetcherEnabled = process.env.LONGEVITY_NEWS_FETCHER_ENABLED !== 'false';
          if (fetcherEnabled) {
            const { startNewsFetcher } = require('./services/longevity-news-fetcher');
            startNewsFetcher();
          }

Suggestion: Specify that `live_room_series_promote_next` begins with `SELECT ... FROM live_rooms WHERE id = p_room_id FOR UPDATE` so the row lock serialises concurrent callers. Alternatively, use `pg_advisory_xact_lock(hashtext('series_promote_' || p_room_id::text))`. Document in the plan that multi-instance concurrency is safe because the SQL function is serialised at the row level.

### R1-F3 [minor]

The plan reuses the `valid_rrule` CHECK regex from `calendar_events`, which allows `BYDAY` (e.g. `FREQ=WEEKLY;BYDAY=MO,WE,FR`). The plan's interface only exposes four frequency choices (daily, weekly, biweekly, monthly) with no day-of-week picker, so the gateway would never generate a BYDAY rule. But the CHECK on the new `live_room_series.rrule` column would silently accept a BYDAY rule inserted by any service_role caller (or a future code path), and the materialiser would then create occurrences on those weekdays — behaviour the plan declares out of scope. A stricter CHECK that forbids BYDAY would make the constraint self-documenting.

- `exafyltd/vitana-platform:supabase/migrations/20260923130000_vtid_04331_calendar_data_model.sql:31` — ALTER TABLE public.calendar_events ADD CONSTRAINT valid_rrule
  CHECK (rrule IS NULL OR rrule ~ '^FREQ=(DAILY|WEEKLY|MONTHLY)(;(INTERVAL=[1-9][0-9]*|COUNT=[1-9][0-9]*|UNTIL=[0-9]{8}T[0-9]{6}Z|BYDAY=(MO|TU|WE|TH|FR|SA|SU)(,(MO|TU|WE|TH|FR|SA|SU))*))*$');

Suggestion: Write a tighter CHECK for `live_room_series.rrule` that omits the BYDAY alternative, e.g. `^FREQ=(DAILY|WEEKLY|MONTHLY)(;(INTERVAL=[1-9][0-9]*|COUNT=[1-9][0-9]*|UNTIL=[0-9]{8}T[0-9]{6}Z))*$`. This prevents accidental BYDAY rules from entering the series table.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
