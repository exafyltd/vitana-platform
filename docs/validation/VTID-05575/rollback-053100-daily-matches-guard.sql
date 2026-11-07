-- VTID-05575 rollback of 20261102053100: drop the daily_matches guard trigger and its three functions.
-- Run AFTER rollback-053200 (the matchers call is_network_candidate through intent_pool_allows) and BEFORE rollback-053000.
-- Refuses while intent_pool_allows exists. NOT restored: the health-derived reason entries the migration removed from existing
-- rows (shared_pillar, similar_index ...). They were derived values on 24-hour rows that the nightly recompute rewrites, they
-- are exactly what D25 forbids, and no snapshot is kept; the next recompute writes whatever the writer produces.
-- Safe to re-run. Run after the owner approves (collaboration.md 7d).
BEGIN;
SET LOCAL lock_timeout = '3s';
DO $rb$
BEGIN
  IF to_regprocedure('public.intent_pool_allows(uuid,uuid,uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'VTID-05575 rollback: run rollback-053200-intent-matchers-scope.sql first (intent_pool_allows still exists)';
  END IF;
END
$rb$;
DO $rb$
BEGIN
  IF to_regclass('public.daily_matches') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_daily_matches_scope_guard ON public.daily_matches;
  END IF;
END
$rb$;
DROP FUNCTION IF EXISTS public.daily_matches_scope_guard();
DROP FUNCTION IF EXISTS public.strip_health_match_reasons(jsonb);
DROP FUNCTION IF EXISTS public.is_network_candidate(uuid);
COMMIT;
