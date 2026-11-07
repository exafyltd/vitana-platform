-- VTID-05570 read-only POST-check (run after 20261102041200_vtid_05570_memfacts_merge_run.sql). SELECT only.
-- 1. One current fact per (tenant_id, user_id, fact_key, entity): must be 0.
SELECT count(*) AS groups_with_more_than_one_current_fact
  FROM (SELECT 1 FROM public.memory_facts WHERE superseded_by IS NULL
         GROUP BY tenant_id, user_id, fact_key, entity HAVING count(*) > 1) d;
-- 2. Nothing deleted: total_facts equals pre-check total_facts; current_facts dropped by rows_to_supersede.
SELECT count(*) FILTER (WHERE superseded_by IS NULL)     AS current_facts,
       count(*) FILTER (WHERE superseded_by IS NOT NULL) AS superseded_facts,
       count(*)                                          AS total_facts
  FROM public.memory_facts;
-- 3. Every snapshotted loser points at a winner that exists and is in the same group (must be 0).
SELECT count(*) AS bad_supersede_links
  FROM public.bak_mt_data_cleanup_memory_facts_merge b
  JOIN public.memory_facts l ON l.id = b.id AND l.superseded_by IS NOT NULL AND b.superseded_by IS NULL
  LEFT JOIN public.memory_facts w ON w.id = l.superseded_by
 WHERE w.id IS NULL OR (w.tenant_id, w.user_id, w.fact_key, w.entity) IS DISTINCT FROM (l.tenant_id, l.user_id, l.fact_key, l.entity);
-- 4. Snapshot size (rows of duplicate groups, winners and losers).
SELECT count(*) AS snapshot_rows FROM public.bak_mt_data_cleanup_memory_facts_merge;
