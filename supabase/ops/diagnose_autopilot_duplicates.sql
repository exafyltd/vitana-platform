-- Diagnostic: explain the duplicate-PR storm.
-- Read-only; safe to run.

\set ON_ERROR_STOP on

\echo '=== 1. Findings created in last 5 days ==='
SELECT date_trunc('day', created_at) AS day,
       count(*) AS findings,
       count(DISTINCT signal_fingerprint) AS distinct_fingerprints,
       count(*) FILTER (WHERE status = 'new') AS still_new,
       count(*) FILTER (WHERE status = 'completed') AS completed,
       count(*) FILTER (WHERE status = 'snoozed') AS snoozed,
       count(*) FILTER (WHERE status = 'rejected') AS rejected
FROM autopilot_recommendations
WHERE source_type IN ('dev_autopilot', 'dev_autopilot_impact')
  AND created_at >= now() - interval '5 days'
GROUP BY 1
ORDER BY 1 DESC;

\echo ''
\echo '=== 2. Top 10 fingerprints by execution count (last 5 days) ==='
SELECT r.signal_fingerprint,
       count(DISTINCT r.id) AS finding_count,
       count(e.id) AS exec_count,
       count(e.pr_url) AS prs_opened,
       array_agg(DISTINCT e.status) AS exec_statuses,
       max(r.title) AS sample_title
FROM autopilot_recommendations r
LEFT JOIN dev_autopilot_executions e ON e.finding_id = r.id
WHERE r.source_type IN ('dev_autopilot', 'dev_autopilot_impact')
  AND r.created_at >= now() - interval '5 days'
GROUP BY r.signal_fingerprint
ORDER BY exec_count DESC NULLS LAST
LIMIT 10;

\echo ''
\echo '=== 3. Findings with > 1 execution row ==='
SELECT r.id AS finding_id,
       r.signal_fingerprint,
       r.status,
       r.title,
       count(e.id) AS exec_count,
       count(e.pr_url) AS prs_opened,
       array_agg(e.status ORDER BY e.approved_at) AS exec_statuses
FROM autopilot_recommendations r
JOIN dev_autopilot_executions e ON e.finding_id = r.id
WHERE r.source_type IN ('dev_autopilot', 'dev_autopilot_impact')
  AND r.created_at >= now() - interval '5 days'
GROUP BY r.id, r.signal_fingerprint, r.status, r.title
HAVING count(e.id) > 1
ORDER BY count(e.id) DESC
LIMIT 15;

\echo ''
\echo '=== 4. Execution status distribution (last 5 days) ==='
SELECT status, count(*) AS rows
FROM dev_autopilot_executions
WHERE approved_at >= now() - interval '5 days'
GROUP BY 1
ORDER BY 2 DESC;

\echo ''
\echo '=== 5. Are duplicate PRs sharing finding_id, or one-PR-per-finding? ==='
WITH pr_per_finding AS (
  SELECT finding_id, count(*) AS prs
  FROM dev_autopilot_executions
  WHERE pr_url IS NOT NULL
    AND approved_at >= now() - interval '5 days'
  GROUP BY finding_id
)
SELECT prs AS prs_per_finding,
       count(*) AS findings_with_this_many_prs,
       sum(prs) AS total_prs_in_bucket
FROM pr_per_finding
GROUP BY prs
ORDER BY prs DESC;

\echo ''
\echo '=== 6. Did the inflight unique index actually exist? ==='
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'dev_autopilot_executions'
  AND indexname LIKE '%inflight%';
