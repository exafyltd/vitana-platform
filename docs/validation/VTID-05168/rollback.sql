-- VTID-05168 rollback — restores the pre-migration functions exactly.
-- Requires docs/validation/VTID-05168/pre-apply-definitions.sql, captured with
-- pre-apply-capture.sql right before the migration was applied.
-- vitana_index_movements is kept (history; nothing reads it once rolled back).
BEGIN;
-- 1. Remove the wrapper that took the old name, give the canonical body its name back.
DROP FUNCTION IF EXISTS public.health_compute_vitana_index_for_user(uuid, date, text);
ALTER FUNCTION public.health_compute_vitana_index_core(uuid, date, text) RENAME TO health_compute_vitana_index_for_user;
-- 2. Replay the captured definitions (CREATE OR REPLACE for the other four).
\ir pre-apply-definitions.sql
-- 3. Restore the original grants.
REVOKE ALL ON FUNCTION public.health_compute_vitana_index_for_user(uuid, date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.health_compute_vitana_index_for_user(uuid, date, text) TO service_role;
DO $m$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'migrate') THEN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.health_compute_vitana_index_for_user(uuid, date, text) TO migrate'; END IF; END $m$;
-- 4. The recording function is no longer called by anything; drop it.
DROP FUNCTION IF EXISTS public.vitana_index_recompute_and_record(uuid, date, text, text, text, text);
COMMIT;
-- The gateway keeps working after a rollback: record-recompute.ts falls back to
-- health_compute_vitana_index_for_user when the recording function is missing.
