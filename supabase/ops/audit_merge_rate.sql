-- The real question: does the autopilot actually ship working code?

\set ON_ERROR_STOP on

\echo '=== A. All-time terminal-state distribution for dev_autopilot executions ==='
SELECT status, count(*)
FROM dev_autopilot_executions
GROUP BY status
ORDER BY count(*) DESC;

\echo ''
\echo '=== B. Last 14 days — terminal status distribution ==='
SELECT status, count(*)
FROM dev_autopilot_executions
WHERE approved_at >= now() - interval '14 days'
GROUP BY status
ORDER BY count(*) DESC;

\echo ''
\echo '=== C. Last 14 days — daily completion rate ==='
SELECT date_trunc('day', approved_at) AS day,
       count(*) AS total,
       count(*) FILTER (WHERE status = 'completed') AS completed,
       count(*) FILTER (WHERE pr_url IS NOT NULL) AS prs_opened,
       round(100.0 * count(*) FILTER (WHERE status = 'completed') / NULLIF(count(*), 0), 1) AS completion_pct
FROM dev_autopilot_executions
WHERE approved_at >= now() - interval '14 days'
GROUP BY 1
ORDER BY 1 DESC;

\echo ''
\echo '=== D. Failure-reason breakdown (last 14 days) — what actually blocks merges? ==='
SELECT
  CASE
    WHEN metadata->>'error' LIKE '%no actual diff%' THEN 'LLM produced no diff'
    WHEN metadata->>'error' LIKE '%no files_referenced%' THEN 'plan empty files_referenced'
    WHEN metadata->>'error' LIKE '%branch-protection blocked%' THEN 'CI: branch protection blocked'
    WHEN metadata->>'error' LIKE '%non-passing checks%' THEN 'CI: non-passing checks'
    WHEN metadata->>'error' LIKE '%PR closed without merge%' THEN 'PR closed without merge'
    WHEN metadata->>'error' LIKE '%inflight_unique_skip%' THEN 'inflight unique skip (race)'
    WHEN metadata->>'error' IS NULL THEN 'no error logged'
    ELSE substr(metadata->>'error', 1, 60)
  END AS reason,
  count(*) AS execs
FROM dev_autopilot_executions
WHERE approved_at >= now() - interval '14 days'
  AND status IN ('failed', 'reverted', 'failed_escalated', 'auto_archived')
GROUP BY 1
ORDER BY count(*) DESC;

\echo ''
\echo '=== E. Findings actually shipped (status=completed) in last 14 days ==='
SELECT r.id AS finding_id,
       r.title,
       e.pr_url,
       e.completed_at
FROM dev_autopilot_executions e
JOIN autopilot_recommendations r ON r.id = e.finding_id
WHERE e.status = 'completed'
  AND e.approved_at >= now() - interval '14 days'
ORDER BY e.completed_at DESC
LIMIT 20;

\echo ''
\echo '=== F. CI-failed detail: what required checks are blocking? ==='
-- Sample 10 ci_failed events in last 14 days to see the failure messages
SELECT created_at, left(message, 200) AS message
FROM oasis_events
WHERE topic = 'dev_autopilot.execution.ci_failed'
  AND created_at >= now() - interval '14 days'
ORDER BY created_at DESC
LIMIT 10;
