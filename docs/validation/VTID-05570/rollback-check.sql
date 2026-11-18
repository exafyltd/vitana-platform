-- VTID-05570 read-only ROLLBACK-check (run after 20261102041100_vtid_05570_memfacts_merge_rollback.sql was applied for real).
-- SELECT only. Every snapshot row has its pre-merge superseded_by / superseded_at again: must be 0.
SELECT count(*) AS snapshot_rows_not_restored
  FROM public.bak_mt_data_cleanup_memory_facts_merge b
  JOIN public.memory_facts t ON t.id = b.id
 WHERE t.superseded_by IS DISTINCT FROM b.superseded_by OR t.superseded_at IS DISTINCT FROM b.superseded_at;
-- No snapshot row was deleted from memory_facts: must be 0.
SELECT count(*) AS snapshot_rows_missing
  FROM public.bak_mt_data_cleanup_memory_facts_merge b
 WHERE NOT EXISTS (SELECT 1 FROM public.memory_facts t WHERE t.id = b.id);
