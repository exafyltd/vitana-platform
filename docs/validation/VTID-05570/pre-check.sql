-- VTID-05570 read-only PRE-check (run by Kiro through RUN-MIGRATION's read-only check, never from this PR).
-- Run after 20261102041000 is applied and BEFORE 20261102041200_vtid_05570_memfacts_merge_run.sql. SELECT only.
-- 1. How many groups have more than one current fact, and how many rows the merge will supersede.
SELECT count(*)                  AS duplicate_groups,
       coalesce(sum(n - 1), 0)   AS rows_to_supersede,
       coalesce(max(n), 0)       AS largest_group
  FROM (SELECT count(*) AS n FROM public.memory_facts WHERE superseded_by IS NULL
         GROUP BY tenant_id, user_id, fact_key, entity HAVING count(*) > 1) d;
-- 2. Baseline: current and superseded totals (compare with post-check.sql: current drops by rows_to_supersede).
SELECT count(*) FILTER (WHERE superseded_by IS NULL)     AS current_facts,
       count(*) FILTER (WHERE superseded_by IS NOT NULL) AS superseded_facts,
       count(*)                                          AS total_facts
  FROM public.memory_facts;
