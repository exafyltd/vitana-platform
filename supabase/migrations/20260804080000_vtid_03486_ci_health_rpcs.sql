-- VTID-03486 / VTID-03485 — CI health RPCs, reachable over HTTPS.
--
-- WHY THESE EXIST
-- ---------------
-- Every health/alert workflow in this repo talks to Postgres with `psql
-- "$SUPABASE_DB_URL"` against the pooler. That path is dead from GitHub
-- Actions: the Supabase project has a network allow-list, and runner IPs are
-- not on it. Observed 2026-08-04:
--
--   psql: error: connection to server at "aws-1-eu-north-1.pooler.supabase.com"
--   port 6543 failed: FATAL: (EADDRNOTALLOWED) address not in tenant
--   allow_list: {4, 155, 197, 83}
--
-- ALERT-WELCOME-GREETING-HEALTH.yml has failed EVERY scheduled run for at
-- least 6 days with the identical error (different runner IP each time). It is
-- not flaky — it is structurally unable to connect.
--
-- PostgREST (https://<project>.supabase.co/rest/v1/...) is a separate edge
-- service and is NOT subject to that database allow-list, so CI can reach it
-- with the SUPABASE_URL + SUPABASE_SERVICE_ROLE secrets that already exist in
-- this repo. These two functions expose exactly what the health checks need
-- over that path, and nothing more.
--
-- SECURITY
-- --------
-- Both are SECURITY DEFINER (they read catalog/telemetry a caller may not
-- otherwise reach) and both are locked to service_role only — EXECUTE is
-- revoked from PUBLIC, anon and authenticated. They return schema metadata and
-- aggregate counts, never user rows or content.

-- ---------------------------------------------------------------------------
-- 1. Schema inventory — the list of public base tables.
--    Consumed by MIGRATION-DRIFT-CHECK.yml to answer "does every table a
--    migration declares actually exist?".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ci_schema_inventory()
RETURNS TABLE (table_name text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
STABLE
AS $$
  SELECT c.relname::text
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     -- 'r' ordinary + 'p' PARTITIONED. Both are needed to match what
     -- information_schema.tables reports as BASE TABLE. Filtering to 'r' alone
     -- drops partitioned parents — `memory_audit_log` is one, and a migration
     -- does declare CREATE TABLE for it, so the drift check would have reported
     -- it as missing. Caught by a 509-vs-510 count mismatch during build.
     AND c.relkind IN ('r', 'p')
   ORDER BY c.relname;
$$;

REVOKE ALL ON FUNCTION public.ci_schema_inventory() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ci_schema_inventory() TO service_role;

COMMENT ON FUNCTION public.ci_schema_inventory() IS
  'VTID-03486: public base-table inventory for the CI migration-drift check. '
  'Exists because GitHub Actions cannot reach the DB pooler (IP allow-list); '
  'this is reachable over PostgREST. service_role only.';

-- ---------------------------------------------------------------------------
-- 2. ORB session-state health — the counts ALERT-ORB-SESSION-STATE-HEALTH.yml
--    needs, in one round trip.
--
--    `ok` inside an audio_ready.acked event is the return value of
--    writeOrbSessionState(), NOT the client's readiness. Misreading it as
--    client readiness is precisely what let VTID-03480 hide for ~2 months.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ci_orb_session_state_health()
RETURNS json
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
STABLE
AS $$
  SELECT json_build_object(
    'table_exists', EXISTS (
      SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'orb_session_state'
         AND c.relkind IN ('r', 'p')
    ),
    'session_starts_24h', (
      SELECT count(*) FROM public.oasis_events
       WHERE topic = 'orb.session.identity.resolved'
         AND created_at >= now() - interval '24 hours'
    ),
    'state_writes_24h', (
      SELECT count(*) FROM public.orb_session_state
       WHERE updated_at >= now() - interval '24 hours'
    ),
    'acks_24h', (
      SELECT count(*) FROM public.oasis_events
       WHERE topic = 'orb.session.audio_ready.acked'
         AND created_at >= now() - interval '24 hours'
    ),
    'acks_failed_24h', (
      SELECT count(*) FROM public.oasis_events
       WHERE topic = 'orb.session.audio_ready.acked'
         AND created_at >= now() - interval '24 hours'
         AND COALESCE(metadata->>'ok', meta->>'ok') = 'false'
    )
  );
$$;

REVOKE ALL ON FUNCTION public.ci_orb_session_state_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ci_orb_session_state_health() TO service_role;

COMMENT ON FUNCTION public.ci_orb_session_state_health() IS
  'VTID-03485: aggregate ORB session-state health for the daily alert. '
  'acks_failed_24h counts audio_ready.acked events whose ok flag is false — '
  'that flag is the writeOrbSessionState() return, not client readiness.';
