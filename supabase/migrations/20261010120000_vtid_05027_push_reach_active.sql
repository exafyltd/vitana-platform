-- VTID-05027: how many ACTIVE members actually get their pushes.
--
-- The push-dispatch health check only watched the backlog and the FCM error
-- share, so "every row handled" looked healthy while most members had no
-- device at all. This function answers the question the owner asked: of the
-- members who use the app, how many did a push reach?
--
--   active   = members who, in the window, read a notification, opened the app
--              (user_device_session_log) or sent a chat message.
--   eligible = active members with at least one push-eligible notification in
--              the window: push_outcome recorded and not suppressed_* (a
--              member's own opt-out / quiet hours is not a reach failure).
--   reached  = eligible members with at least one delivered_* outcome.
--
-- Test and service accounts (notification_test_actors, service_bot_accounts)
-- are never counted. Read-only, plain Postgres (no Supabase-specific
-- features), EXECUTE for service_role only.

BEGIN;

CREATE OR REPLACE FUNCTION public.push_reach_active(p_days integer DEFAULT 7)
RETURNS TABLE (active bigint, eligible bigint, reached bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH win AS (
    SELECT now() - make_interval(days => GREATEST(1, LEAST(COALESCE(p_days, 7), 90))) AS since
  ),
  excluded AS (
    SELECT user_id FROM notification_test_actors
    UNION
    SELECT user_id FROM service_bot_accounts
  ),
  active_members AS (
    SELECT n.user_id FROM user_notifications n, win WHERE n.read_at >= win.since
    UNION
    SELECT s.user_id FROM user_device_session_log s, win WHERE s.started_at >= win.since
    UNION
    SELECT c.sender_id FROM chat_messages c, win WHERE c.created_at >= win.since
  ),
  members AS (
    SELECT a.user_id FROM active_members a
     WHERE a.user_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM excluded e WHERE e.user_id = a.user_id)
  ),
  outcomes AS (
    SELECT n.user_id,
           bool_or(n.push_outcome LIKE 'delivered\_%') AS delivered
      FROM user_notifications n, win
     WHERE n.created_at >= win.since
       AND n.push_outcome IS NOT NULL
       AND n.push_outcome NOT LIKE 'suppressed\_%'
     GROUP BY n.user_id
  )
  SELECT (SELECT count(*) FROM members)::bigint,
         count(o.user_id)::bigint,
         count(o.user_id) FILTER (WHERE o.delivered)::bigint
    FROM members m
    JOIN outcomes o ON o.user_id = m.user_id;
$$;

REVOKE ALL ON FUNCTION public.push_reach_active(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.push_reach_active(integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.push_reach_active(integer) TO service_role;

COMMENT ON FUNCTION public.push_reach_active(integer) IS
  'VTID-05027: active/eligible/reached member counts for push delivery over the last p_days (1-90). Excludes test and service accounts.';

COMMIT;
