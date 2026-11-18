-- VTID-05575 rollback of 20261102053000: drop daily_matches.scope and .tenant_id (and their index and CHECK).
-- Run LAST (after rollback-053200 and rollback-053100). Refuses while the guard trigger exists. The scope / tenant stamps are derived from user_tenants and are recomputed by the next
-- migration run; no other data is touched. Safe to re-run. Run after the owner approves (collaboration.md 7d).
BEGIN;
SET LOCAL lock_timeout = '3s';
DO $rb$
BEGIN
  IF to_regclass('public.daily_matches') IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.daily_matches'::regclass AND tgname = 'trg_daily_matches_scope_guard') THEN
    RAISE EXCEPTION 'VTID-05575 rollback: run rollback-053100-daily-matches-guard.sql first (the guard trigger still exists)';
  END IF;
  DROP INDEX IF EXISTS public.idx_daily_matches_scope_tenant;
  ALTER TABLE public.daily_matches DROP CONSTRAINT IF EXISTS daily_matches_scope_check;
  ALTER TABLE public.daily_matches DROP COLUMN IF EXISTS scope, DROP COLUMN IF EXISTS tenant_id;
END
$rb$;
COMMIT;
