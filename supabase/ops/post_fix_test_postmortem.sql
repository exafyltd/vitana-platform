-- Post-mortem of the unattended test AFTER the unit-workflow fix
-- (2026-05-08 09:23 → 09:58 UTC)

\set ON_ERROR_STOP on

\echo '=== A. Per-finding execution + PR + completed counts (THE MERGE TEST) ==='
SELECT
  e.finding_id,
  left(r.title, 70) AS title,
  count(*) AS execs,
  count(e.pr_url) AS prs_opened,
  count(*) FILTER (WHERE e.status = 'completed') AS completed,
  array_agg(e.status ORDER BY e.approved_at) AS statuses
FROM dev_autopilot_executions e
JOIN autopilot_recommendations r ON r.id = e.finding_id
WHERE e.approved_at >= '2026-05-08 09:23:00+00'
  AND e.approved_at <= '2026-05-08 10:00:00+00'
GROUP BY e.finding_id, r.title
ORDER BY count(*) FILTER (WHERE e.status = 'completed') DESC, count(*) DESC;

\echo ''
\echo '=== B. Status distribution in the window ==='
SELECT status, count(*)
FROM dev_autopilot_executions
WHERE approved_at >= '2026-05-08 09:23:00+00'
  AND approved_at <= '2026-05-08 10:00:00+00'
GROUP BY status
ORDER BY count(*) DESC;

\echo ''
\echo '=== C. Currently OPEN PRs (per finding) ==='
SELECT e.finding_id,
       array_agg(DISTINCT e.pr_url) AS pr_urls,
       array_agg(DISTINCT e.status) AS exec_statuses
FROM dev_autopilot_executions e
WHERE e.approved_at >= '2026-05-08 09:23:00+00'
  AND e.pr_url IS NOT NULL
  AND e.status NOT IN ('completed', 'self_healed', 'auto_archived')
GROUP BY e.finding_id;

\echo ''
\echo '=== D. ci_failed reasons (was branch-protection still the blocker?) ==='
SELECT left(message, 130) AS message, count(*)
FROM oasis_events
WHERE topic = 'dev_autopilot.execution.ci_failed'
  AND created_at >= '2026-05-08 09:23:00+00'
GROUP BY 1
ORDER BY count(*) DESC;

\echo ''
\echo '=== E. Findings flipped to status=completed in window ==='
SELECT id, status, completed_at, left(title, 80) AS title
FROM autopilot_recommendations
WHERE source_type = 'dev_autopilot'
  AND status = 'completed'
  AND completed_at >= '2026-05-08 09:23:00+00';

\echo ''
\echo '=== F. Pipeline event timeline ==='
SELECT created_at, topic, status, left(message, 110) AS message
FROM oasis_events
WHERE created_at >= '2026-05-08 09:23:00+00'
  AND created_at <= '2026-05-08 10:00:00+00'
  AND topic LIKE 'dev_autopilot.execution.%'
ORDER BY created_at;
