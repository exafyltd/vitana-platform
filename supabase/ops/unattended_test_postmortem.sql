-- Post-mortem of the 35-min unattended test (2026-05-08 08:17 → 08:52 UTC)

\set ON_ERROR_STOP on

\echo '=== A. Per-finding execution count + PR count (THE FLOOD CHECK) ==='
WITH window_execs AS (
  SELECT *
  FROM dev_autopilot_executions
  WHERE approved_at >= '2026-05-08 08:17:00+00'
    AND approved_at <= '2026-05-08 08:53:00+00'
)
SELECT
  finding_id,
  count(*) AS exec_count,
  count(pr_url) AS prs_opened,
  count(*) FILTER (WHERE status = 'completed') AS completed,
  array_agg(status ORDER BY approved_at) AS statuses_chronological
FROM window_execs
GROUP BY finding_id
ORDER BY count(pr_url) DESC, count(*) DESC;

\echo ''
\echo '=== B. Total in-window execution status distribution ==='
SELECT status, count(*)
FROM dev_autopilot_executions
WHERE approved_at >= '2026-05-08 08:17:00+00'
  AND approved_at <= '2026-05-08 08:53:00+00'
GROUP BY status
ORDER BY count(*) DESC;

\echo ''
\echo '=== C. Currently OPEN PRs grouped by finding (the flood signal) ==='
SELECT
  e.finding_id,
  count(DISTINCT e.id) AS execs_with_pr,
  array_agg(DISTINCT e.pr_url) AS pr_urls,
  array_agg(DISTINCT e.status) AS exec_statuses
FROM dev_autopilot_executions e
WHERE e.approved_at >= '2026-05-08 08:17:00+00'
  AND e.pr_url IS NOT NULL
  AND e.status NOT IN ('completed', 'self_healed', 'auto_archived')
GROUP BY e.finding_id
ORDER BY count(*) DESC;

\echo ''
\echo '=== D. Did revert close PRs for real? Check for #closed-dry-run stubs ==='
SELECT
  count(*) FILTER (WHERE message LIKE '%closed-dry-run%') AS dry_run_revert_stubs,
  count(*) FILTER (WHERE message LIKE '%#closed%' AND message NOT LIKE '%dry-run%') AS real_closes,
  count(*) FILTER (WHERE topic = 'dev_autopilot.execution.reverted') AS revert_events_total
FROM oasis_events
WHERE created_at >= '2026-05-08 08:17:00+00'
  AND topic = 'dev_autopilot.execution.reverted';

\echo ''
\echo '=== E. Headline event timeline ==='
SELECT created_at, topic, status, left(message, 110) AS message
FROM oasis_events
WHERE created_at >= '2026-05-08 08:17:00+00'
  AND topic LIKE 'dev_autopilot.execution.%'
ORDER BY created_at ASC
LIMIT 60;

\echo ''
\echo '=== F. Findings whose status changed during the window ==='
SELECT id, status, snoozed_until, left(title, 70) AS title
FROM autopilot_recommendations
WHERE source_type = 'dev_autopilot'
  AND updated_at >= '2026-05-08 08:17:00+00'
ORDER BY updated_at;

\echo ''
\echo '=== G. Open PR-flood guard activity (was it doing its job?) ==='
SELECT count(*) AS total_in_window
FROM dev_autopilot_executions
WHERE approved_at >= '2026-05-08 08:17:00+00';
