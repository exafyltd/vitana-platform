-- VTID-05052 — ci_welcome_greeting_health(): stop counting registered
-- test/service accounts as signups.
--
-- ALERT-WELCOME-GREETING-HEALTH.yml failed on 2026-10-08 ("2 new signups in
-- last 24h but ZERO trigger-fired greetings") and turned morning-check row 22
-- red. Both signups in that window were registered in service_bot_accounts
-- and notification_test_actors; the welcome trigger correctly skipped them.
-- The RPC only excluded the welcome bot UUID, so a 24h window holding only
-- test accounts always reported a false outage.
--
-- signups_24h and unflagged_24h now exclude both allowlists (CLAUDE.md rules
-- 43-45; the same accounts fire_welcome_chat_on_membership() skips).
-- greeted_senders_24h, the return keys, SECURITY DEFINER, search_path and the
-- service_role-only grant are unchanged from
-- 20260804100000_vtid_03492_ci_health_rpcs_v2.sql.
--
-- notification_test_actors is created by exafyltd/vitana-v1 migration
-- 20260805160000 in the same Supabase project.
--
-- Idempotent: CREATE OR REPLACE with the same signature.

CREATE OR REPLACE FUNCTION public.ci_welcome_greeting_health()
RETURNS json
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
STABLE
AS $$
  SELECT json_build_object(
    'trigger_present', EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgname = 'welcome_chat_on_primary_membership'
    ),
    -- tgenabled 'O' = enabled, "origin". Anything else means disabled/replica-only.
    'trigger_enabled', COALESCE(
      (SELECT tgenabled::text = 'O' FROM pg_trigger
        WHERE tgname = 'welcome_chat_on_primary_membership'), false),
    'function_present', EXISTS (
      SELECT 1 FROM pg_proc WHERE proname = 'fire_welcome_chat_on_membership'
    ),
    'function_secdef', COALESCE(
      (SELECT prosecdef FROM pg_proc
        WHERE proname = 'fire_welcome_chat_on_membership' LIMIT 1), false),
    'trigger_table', (
      SELECT c.relname::text FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
       WHERE t.tgname = 'welcome_chat_on_primary_membership'
    ),
    'signups_24h', (
      SELECT count(*) FROM public.app_users
       WHERE created_at >= now() - interval '24 hours'
         AND user_id <> '00000000-0000-0000-0000-000000000001'::uuid
         -- VTID-05052: registered test/service accounts are never greeted (the
         -- welcome trigger skips them), so they are not signups for this check.
         AND user_id NOT IN (SELECT s.user_id FROM public.service_bot_accounts s)
         AND user_id NOT IN (SELECT n.user_id FROM public.notification_test_actors n)
    ),
    'greeted_senders_24h', (
      SELECT count(DISTINCT sender_id) FROM public.chat_messages
       WHERE created_at >= now() - interval '24 hours'
         AND metadata->>'source' = 'welcome_chat'
         AND metadata->>'trigger' = 'db_trigger_on_membership'
    ),
    'unflagged_24h', (
      SELECT count(*) FROM public.app_users
       WHERE created_at >= now() - interval '24 hours'
         AND COALESCE(welcome_chat_sent, false) = false
         AND user_id <> '00000000-0000-0000-0000-000000000001'::uuid
         -- VTID-05052: registered test/service accounts are never greeted (the
         -- welcome trigger skips them), so they are not signups for this check.
         AND user_id NOT IN (SELECT s.user_id FROM public.service_bot_accounts s)
         AND user_id NOT IN (SELECT n.user_id FROM public.notification_test_actors n)
    )
  );
$$;

REVOKE ALL ON FUNCTION public.ci_welcome_greeting_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ci_welcome_greeting_health() TO service_role;

COMMENT ON FUNCTION public.ci_welcome_greeting_health() IS
  'VTID-03492 / VTID-05052: structural + behavioral welcome-greeting trigger health for CI; '
  'signups exclude service_bot_accounts and notification_test_actors. '
  'Reachable over PostgREST because GitHub Actions cannot reach the DB pooler.';
