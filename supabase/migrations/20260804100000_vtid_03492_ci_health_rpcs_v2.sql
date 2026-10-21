-- VTID-03492 — CI health RPCs for the remaining psql-based workflows.
--
-- Follow-up to VTID-03485/03486. Six workflows still reached the database with
-- `psql "$SUPABASE_DB_URL"` from GitHub Actions, which cannot connect: the
-- Supabase project has a network allow-list and runner IPs are not on it
-- ("FATAL: (EADDRNOTALLOWED) address not in tenant allow_list"). Runner IPs
-- differ per run, so allow-listing is not a practical fix.
--
-- Three of those six are read-only health checks and are converted here to
-- PostgREST/HTTPS, which is a separate edge service not subject to the DB
-- allow-list:
--   ALERT-WELCOME-GREETING-HEALTH.yml   -> ci_welcome_greeting_health()
--   SMOKE-WELCOME-GREETING.yml          -> ci_welcome_greeting_health()
--   MORNING-SYSTEM-HEALTH-CHECK.yml     -> both functions below
--
-- The other three (RUN-MIGRATION, RUN-STAGING-MIGRATION, VTID-02409-BOOTSTRAP)
-- apply migration FILES — arbitrary DDL. PostgREST cannot do that, and adding
-- an RPC that EXECUTEs caller-supplied SQL would be a remote-DDL-execution
-- endpoint on production. Deliberately NOT done here; those move to the
-- Supabase Management API instead. See the workflows' own headers.
--
-- SECURITY: both are SECURITY DEFINER (they read pg_catalog and user tables)
-- and locked to service_role — EXECUTE revoked from PUBLIC/anon/authenticated.
-- They return booleans and aggregate counts, never user rows or content.

-- ---------------------------------------------------------------------------
-- Welcome-greeting trigger health: structural (does the trigger exist, is it
-- enabled, is it SECURITY DEFINER, is it on the right table) and behavioral
-- (did real signups in the last 24h actually get greeted).
--
-- Structural and behavioral are both needed: the trigger can be present and
-- enabled while still not firing, which is the failure ALERT-WELCOME-GREETING-
-- HEALTH.yml exists to catch.
-- ---------------------------------------------------------------------------
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
    )
  );
$$;

REVOKE ALL ON FUNCTION public.ci_welcome_greeting_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ci_welcome_greeting_health() TO service_role;

COMMENT ON FUNCTION public.ci_welcome_greeting_health() IS
  'VTID-03492: structural + behavioral welcome-greeting trigger health for CI. '
  'Reachable over PostgREST because GitHub Actions cannot reach the DB pooler.';

-- ---------------------------------------------------------------------------
-- General system health for the morning check: DB reachability (implicit — a
-- successful call proves it), orphaned VTID claims, and OASIS event recency.
--
-- oasis_events excludes 'telemetry.%' on purpose: CLAUDE.md §6 — polling and
-- heartbeats are not events, so counting them would mask a stalled pipeline.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ci_system_health()
RETURNS json
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
STABLE
AS $$
  SELECT json_build_object(
    'db_ok', true,
    'orphaned_claims', (
      SELECT count(*) FROM public.vtid_ledger
       WHERE status = 'in_progress'
         AND claimed_by IS NOT NULL
         AND claim_expires_at < now()
    ),
    'oasis_events_6h', (
      SELECT count(*) FROM public.oasis_events
       WHERE created_at > now() - interval '6 hours'
         AND topic NOT LIKE 'telemetry.%'
    )
  );
$$;

REVOKE ALL ON FUNCTION public.ci_system_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ci_system_health() TO service_role;

COMMENT ON FUNCTION public.ci_system_health() IS
  'VTID-03492: DB reachability, orphaned VTID claims and OASIS event recency '
  'for MORNING-SYSTEM-HEALTH-CHECK. service_role only.';
