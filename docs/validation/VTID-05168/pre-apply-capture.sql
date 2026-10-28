-- VTID-05168 — run READ-ONLY against the live database immediately BEFORE
-- applying 20261014140000_vtid_05168_index_movements.sql. It prints the exact
-- live definitions the migration replaces; save the output next to
-- rollback.sql as pre-apply-definitions.sql (the rollback replays it).
SELECT string_agg(pg_get_functiondef(p.oid) || ';', E'\n\n' ORDER BY p.oid::regprocedure::text) AS definitions
  FROM pg_proc p
 WHERE p.oid IN (
   'public.health_compute_vitana_index_for_user(uuid,date,text)'::regprocedure,
   'public.health_compute_vitana_index(date,text)'::regprocedure,
   'public.health_compute_vitana_index(date)'::regprocedure,
   'public.scheduler_vitana_index_compute_daily(uuid,date)'::regprocedure,
   'public.vitana_trg_calendar_completion_recompute()'::regprocedure
 );
-- Run with: psql -X -q -t -A -f pre-apply-capture.sql > pre-apply-definitions.sql
