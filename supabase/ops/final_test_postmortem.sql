-- Final test post-mortem (2026-05-08 10:13 → 10:48 UTC)
-- Both unit gate AND visual-verify advisory shipped

\set ON_ERROR_STOP on

\echo '=== A. Per-finding outcome (the merge-rate test) ==='
SELECT
  e.finding_id,
  left(r.title, 60) AS title,
  count(*) AS execs,
  count(e.pr_url) AS prs_opened,
  count(*) FILTER (WHERE e.status = 'completed') AS completed_status,
  array_agg(e.status ORDER BY e.approved_at) AS chronological_statuses,
  array_agg(e.pr_number ORDER BY e.approved_at) FILTER (WHERE e.pr_number IS NOT NULL) AS pr_numbers
FROM dev_autopilot_executions e
JOIN autopilot_recommendations r ON r.id = e.finding_id
WHERE e.approved_at >= '2026-05-08 10:13:00+00'
  AND e.approved_at <= '2026-05-08 10:50:00+00'
GROUP BY e.finding_id, r.title
ORDER BY count(*) DESC;

\echo ''
\echo '=== B. Status distribution ==='
SELECT status, count(*)
FROM dev_autopilot_executions
WHERE approved_at >= '2026-05-08 10:13:00+00'
  AND approved_at <= '2026-05-08 10:50:00+00'
GROUP BY status
ORDER BY count(*) DESC;

\echo ''
\echo '=== C. Findings whose status flipped to completed ==='
SELECT id, status, completed_at, left(title, 70) AS title
FROM autopilot_recommendations
WHERE source_type = 'dev_autopilot'
  AND status = 'completed'
  AND completed_at >= '2026-05-08 10:13:00+00';

\echo ''
\echo '=== D. ci_failed reasons (still branch-protection? or deeper test failures?) ==='
SELECT left(message, 200) AS message, count(*)
FROM oasis_events
WHERE topic = 'dev_autopilot.execution.ci_failed'
  AND created_at >= '2026-05-08 10:13:00+00'
GROUP BY 1
ORDER BY count(*) DESC;

\echo ''
\echo '=== E. PRs that were MERGED during the window ==='
SELECT created_at, left(message, 130) AS message
FROM oasis_events
WHERE topic = 'dev_autopilot.execution.pr_merged'
  AND created_at >= '2026-05-08 10:13:00+00';

\echo ''
\echo '=== F. PRs that reached deploy step ==='
SELECT created_at, topic, left(message, 130) AS message
FROM oasis_events
WHERE topic IN ('dev_autopilot.execution.deployed', 'dev_autopilot.execution.deploy_failed', 'dev_autopilot.execution.completed')
  AND created_at >= '2026-05-08 10:13:00+00';

\echo ''
\echo '=== G. Full timeline (head + tail) ==='
SELECT created_at, topic, status, left(message, 100) AS message
FROM oasis_events
WHERE created_at >= '2026-05-08 10:13:00+00'
  AND created_at <= '2026-05-08 10:50:00+00'
  AND topic LIKE 'dev_autopilot.execution.%'
ORDER BY created_at;
