-- VTID-05168 — READ-ONLY: the live grants of the functions the migration replaces (record in Gate 2).
SELECT p.oid::regprocedure::text AS fn, array_to_string(p.proacl, ',') AS acl
  FROM pg_proc p
 WHERE p.proname IN ('health_compute_vitana_index_for_user','health_compute_vitana_index',
                     'scheduler_vitana_index_compute_daily','vitana_trg_calendar_completion_recompute')
   AND p.pronamespace = 'public'::regnamespace;
