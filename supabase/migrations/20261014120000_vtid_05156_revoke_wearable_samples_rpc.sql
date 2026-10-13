-- =============================================================================
-- VTID-05156 — health_ingest_wearable_samples(jsonb): service_role only
-- -----------------------------------------------------------------------------
-- Health Hub Phase 0 fix-ups, Defect 5 (program VTID-05020).
--
-- public.health_ingest_wearable_samples(jsonb) is SECURITY DEFINER (owner
-- postgres) and was granted to `authenticated` by
-- 20251231000000_vtid_01078_health_brain_phase_c1.sql (GRANT at the end of
-- section 7.2). Read-only check on the live database 2026-10-13:
-- has_function_privilege('authenticated', …, 'EXECUTE') = true, anon = false,
-- wearable_samples has 0 rows. So any signed-in member could write wearable
-- samples directly through PostgREST, with no consent check.
--
-- Caller inventory: the only caller was the gateway route
-- POST /api/v1/health/wearables/ingest (routes/health.ts, with the member's
-- JWT). That route now answers 410 ENDPOINT_RETIRED before any database call
-- (same PR). The app never called it (vitana-v1 has only the generated type).
-- The Health Hub Phase 1 Health Sync contract replaces it.
--
-- Out of scope: health_ingest_lab_report(jsonb) has the same grant but live
-- callers; it is left to the Phase 1 consent-gated ingest rework.
--
-- Access only: the function body is untouched (a later CREATE OR REPLACE
-- keeps the ACL). Idempotent: REVOKE/GRANT of an absent/present privilege is
-- a no-op. The original migration never granted PUBLIC or anon explicitly;
-- revoking them as well removes Postgres's default PUBLIC EXECUTE if present.
-- Checks effects, never migration rows; refuses to apply (rolls back) unless
-- the end state holds. Fails loudly if the function does not exist.
--
-- Applied ONLY via RUN-MIGRATION.yml after Gate 2, with a read-only
-- before/after has_function_privilege check recorded in Gate 2.
--
-- Rollback (by hand, owner's go): docs/validation/VTID-05156/rollback.sql
-- =============================================================================

BEGIN;

REVOKE EXECUTE ON FUNCTION public.health_ingest_wearable_samples(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.health_ingest_wearable_samples(jsonb) TO service_role;

-- Refuse to apply (rolling everything back) unless the end state holds.
DO $check$
DECLARE
  fn regprocedure := 'public.health_ingest_wearable_samples(jsonb)'::regprocedure;
BEGIN
  IF has_function_privilege('authenticated', fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'VTID-05156: % still executable by authenticated', fn;
  END IF;
  IF has_function_privilege('anon', fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'VTID-05156: % still executable by anon', fn;
  END IF;
  IF NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'VTID-05156: service_role must keep EXECUTE on %', fn;
  END IF;
END
$check$;

COMMIT;
