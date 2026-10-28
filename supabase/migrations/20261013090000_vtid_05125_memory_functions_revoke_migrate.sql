-- =============================================================================
-- VTID-05125 — revoke the `migrate` role's EXECUTE on the four memory functions
-- -----------------------------------------------------------------------------
-- write_fact, get_current_facts, recall_at_time_range and
-- memory_facts_semantic_search are SECURITY DEFINER (owner postgres), take
-- p_user_id and never check auth.uid(). VTID-05041
-- (20261010164100_vtid_05041_definer_functions_lockdown.sql) revoked PUBLIC,
-- anon and authenticated, but its self-check only tested those roles plus
-- service_role. Live 2026-10-12 every one of the four still had the ACL
-- {postgres=X/postgres, service_role=X/postgres, migrate=X/postgres}: whoever
-- holds the `migrate` password could read and overwrite any member's memory
-- facts through the definer path. `migrate` has only SELECT on public tables,
-- so this closes its write path (write_fact); its table SELECT / default-ACL
-- read exposure is follow-up FU9b, its EXECUTE on the other service-only
-- DEFINER functions (decrypt_api_key, wallet/credit RPCs, …) is FU9a.
--
-- What `migrate` is: the AWS DMS source role for the Supabase → Aurora
-- migration (docs/AURORA-MIGRATION-STATUS-2026-09-10.md §1; login,
-- replication, bypassrls, not superuser; `postgres` is a member of it, it is a
-- member of nothing). DMS full load reads tables, CDC reads the replication
-- slot, and it writes only its own awsdms_* tables — it never calls
-- application RPCs, so it does not need EXECUTE here. No workflow, script or
-- service in the repo logs in as `migrate`.
--
-- Caller inventory (unchanged from VTID-05041): the gateway on service_role
-- (services/memory/remember.ts, memory-facts-service.ts,
-- memory-facts-service-repository.ts, tool-recall-conversation.ts) and
-- scripts/backfill-memory-facts.mjs. service_role keeps EXECUTE.
--
-- Access only: bodies untouched (CREATE OR REPLACE later keeps the ACL).
-- Idempotent. Checks effects, never migration rows. No `migrate` role (fresh
-- database, Aurora) → NOTICE, nothing to revoke. A new overload of any of the
-- four names fails the self-check, so it is reviewed rather than revoked
-- silently.
--
-- Rollback (by hand, owner's go, only if something unexpected needs it):
--   docs/validation/VTID-05125/rollback.sql
-- =============================================================================

BEGIN;

DO $revoke$
DECLARE r record;
BEGIN
  IF to_regrole('migrate') IS NULL THEN
    RAISE NOTICE 'VTID-05125: role migrate absent, nothing to revoke';
    RETURN;
  END IF;
  FOR r IN
    SELECT format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid)) AS fn
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
    WHERE p.proname IN ('write_fact', 'get_current_facts', 'recall_at_time_range', 'memory_facts_semantic_search')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM migrate', r.fn);
  END LOOP;
END
$revoke$;

-- Refuse to apply (rolling everything back) unless the end state holds.
DO $check$
DECLARE
  r record;
  n integer := 0;
BEGIN
  -- Same existence check as VTID-05041: all four names present.
  IF (SELECT count(DISTINCT p.proname)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
      WHERE p.proname IN ('write_fact', 'get_current_facts', 'recall_at_time_range', 'memory_facts_semantic_search')) <> 4 THEN
    RAISE EXCEPTION 'VTID-05125: expected all four memory functions to exist';
  END IF;
  FOR r IN
    SELECT p.oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
    WHERE p.proname IN ('write_fact', 'get_current_facts', 'recall_at_time_range', 'memory_facts_semantic_search')
  LOOP
    n := n + 1;
    IF to_regrole('migrate') IS NOT NULL AND has_function_privilege('migrate', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'VTID-05125: % still executable by migrate', r.oid::regprocedure;
    END IF;
    IF has_function_privilege('authenticated', r.oid, 'EXECUTE') OR has_function_privilege('anon', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'VTID-05125: % executable by members — VTID-05041 regressed', r.oid::regprocedure;
    END IF;
    IF NOT has_function_privilege('service_role', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'VTID-05125: service_role (gateway) must keep EXECUTE on %', r.oid::regprocedure;
    END IF;
  END LOOP;
  -- Exact overload count, captured live 2026-10-12: one overload per name (4 total).
  IF n <> 4 THEN
    RAISE EXCEPTION 'VTID-05125: expected exactly 4 overloads, found %', n;
  END IF;
END
$check$;

COMMIT;
