\set ON_ERROR_STOP on

\echo '=== A. Per-finding outcome ==='
SELECT
  e.finding_id,
  left(r.title, 60) AS title,
  r.spec_snapshot->>'scanner' AS scanner,
  count(*) AS execs,
  count(e.pr_url) AS prs_opened,
  count(*) FILTER (WHERE e.status = 'completed') AS completed_status,
  array_agg(e.status ORDER BY e.approved_at) AS chronological,
  array_agg(e.pr_number ORDER BY e.approved_at) FILTER (WHERE e.pr_number IS NOT NULL) AS pr_numbers
FROM dev_autopilot_executions e
JOIN autopilot_recommendations r ON r.id = e.finding_id
WHERE e.approved_at >= '2026-05-08 13:02:00+00'
  AND e.approved_at <= '2026-05-08 13:43:00+00'
GROUP BY e.finding_id, r.title, r.spec_snapshot->>'scanner'
ORDER BY count(*) FILTER (WHERE e.status = 'completed') DESC, count(*) DESC;

\echo ''
\echo '=== B. ci_failed reasons ==='
SELECT left(message, 200), count(*)
FROM oasis_events
WHERE topic = 'dev_autopilot.execution.ci_failed'
  AND created_at >= '2026-05-08 13:02:00+00'
GROUP BY 1
ORDER BY count(*) DESC;

\echo ''
\echo '=== C. PRs that were MERGED in window ==='
SELECT created_at, left(message, 150) AS message
FROM oasis_events
WHERE topic = 'dev_autopilot.execution.pr_merged'
  AND created_at >= '2026-05-08 13:02:00+00';

\echo ''
\echo '=== D. Did the new plans actually include package.json? Inspect latest plan for ed4f62b2 ==='
SELECT version, files_referenced, length(plan_markdown) AS md_len, created_at,
       left(plan_markdown, 1500) AS plan_excerpt
FROM dev_autopilot_plan_versions
WHERE finding_id = 'ed4f62b2-32a4-487c-b5cb-de091dd3b269'
ORDER BY version DESC
LIMIT 1;
