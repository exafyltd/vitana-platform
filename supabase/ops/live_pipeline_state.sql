-- Live snapshot during the auto-approve test window.

\set ON_ERROR_STOP on

\echo '=== Executions in last 10 min ==='
SELECT id, finding_id, status, pr_number, approved_at, updated_at
FROM dev_autopilot_executions
WHERE approved_at >= now() - interval '10 minutes'
ORDER BY approved_at;

\echo ''
\echo '=== Executions per finding in last 10 min (any > 1 ⇒ regression) ==='
SELECT finding_id, count(*) AS exec_count, count(pr_url) AS prs_opened, array_agg(status ORDER BY approved_at) AS statuses
FROM dev_autopilot_executions
WHERE approved_at >= now() - interval '10 minutes'
GROUP BY finding_id;

\echo ''
\echo '=== OASIS dev_autopilot events in last 10 min ==='
SELECT created_at, topic, status, left(message, 110) AS message
FROM oasis_events
WHERE topic LIKE 'dev_autopilot.%'
  AND created_at >= now() - interval '10 minutes'
ORDER BY created_at DESC
LIMIT 30;
