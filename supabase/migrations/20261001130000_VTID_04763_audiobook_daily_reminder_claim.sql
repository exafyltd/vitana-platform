-- =============================================================================
-- VTID-04763 — Audiobook daily reminder: atomic claim of due reminders
-- -----------------------------------------------------------------------------
-- A member can ask for a daily "your episode for today" push at a local time
-- of their choosing (user_guided_journey_state.metadata.audiobook_reminder =
-- { time: 'HH:MM', tz: '<IANA>', last_sent_local_date? }), set through
-- POST /api/v1/journey/audiobook/reminder.
--
-- The gateway runs one dispatch loop per ECS task, so claiming must be atomic:
-- this function picks the due rows with FOR UPDATE SKIP LOCKED and stamps
-- last_sent_local_date in the same statement. Two tasks calling it at the same
-- moment can never both get the same member, and a member gets at most one
-- reminder per local day, whatever the number of tasks or retries.
--
-- Due means, in the member's own time zone:
--   - the local time has reached the chosen time, within a 2-hour catch-up
--     window (a deploy or restart at that minute must not skip a day, and a
--     much later catch-up would arrive at the wrong time of day);
--   - nothing was sent yet on this local date;
--   - they have NOT already listened to an episode today (metadata.daily_listen,
--     written on every finished episode) — the reminder is for the days they
--     haven't, never a nag after they did.
-- A time zone Postgres doesn't know is skipped rather than failing the batch
-- (the gateway validates on write; this is the second gate).
--
-- Returns the member's primary tenant for the push delivery gate. No table or
-- column is created; RLS is unchanged (the function is called with the
-- gateway's service role).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.claim_due_audiobook_reminders(p_limit integer DEFAULT 200)
RETURNS TABLE (user_id uuid, tenant_id uuid, local_date date)
LANGUAGE sql
VOLATILE
SET search_path = public
AS $fn$
  WITH zones AS (
    SELECT name FROM pg_timezone_names
  ),
  -- The planner may compute the select list before the WHERE filters, so
  -- the conversions are guarded by CASE (evaluated lazily): an unknown zone
  -- or a malformed time yields NULL here instead of an error for the batch.
  raw AS (
    SELECT s.user_id,
           s.metadata->'audiobook_reminder'->>'tz' AS tz,
           s.metadata->'audiobook_reminder'->>'time' AS hhmm
      FROM user_guided_journey_state s
     WHERE s.metadata ? 'audiobook_reminder'
  ),
  candidates AS (
    SELECT r.user_id,
           CASE WHEN r.tz IN (SELECT name FROM zones) THEN now() AT TIME ZONE r.tz END AS local_ts,
           CASE WHEN r.hhmm ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN r.hhmm::time END AS remind_at
      FROM raw r
  ),
  due AS (
    SELECT c.user_id, c.local_ts::date AS local_date
      FROM candidates c
      JOIN user_guided_journey_state s ON s.user_id = c.user_id
     WHERE c.local_ts IS NOT NULL
       AND c.remind_at IS NOT NULL
       AND c.local_ts::time >= c.remind_at
       AND c.local_ts::time < c.remind_at + interval '2 hours'
       AND c.remind_at < time '22:00'  -- the 2h window must not wrap past midnight
       AND COALESCE(s.metadata->'audiobook_reminder'->>'last_sent_local_date', '') <> c.local_ts::date::text
       AND COALESCE(s.metadata->'daily_listen'->>'date', '') <> c.local_ts::date::text
     LIMIT GREATEST(1, LEAST(p_limit, 1000))
       FOR UPDATE OF s SKIP LOCKED
  ),
  stamped AS (
    UPDATE user_guided_journey_state s
       SET metadata = jsonb_set(s.metadata, '{audiobook_reminder,last_sent_local_date}', to_jsonb(due.local_date::text)),
           updated_at = now()
      FROM due
     WHERE s.user_id = due.user_id
    RETURNING s.user_id, due.local_date
  )
  SELECT st.user_id,
         (SELECT ut.tenant_id FROM user_tenants ut
           WHERE ut.user_id = st.user_id
           ORDER BY ut.is_primary DESC NULLS LAST, ut.created_at ASC
           LIMIT 1) AS tenant_id,
         st.local_date
    FROM stamped st;
$fn$;

REVOKE ALL ON FUNCTION public.claim_due_audiobook_reminders(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_audiobook_reminders(integer) TO service_role;
