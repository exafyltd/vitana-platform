-- Post-scan validation diagnostic.
-- Run this AFTER triggering a Dev Autopilot Scan + waiting ~5 min for the
-- gateway's autoApproveTick to process new findings. The goal is to prove
-- no finding produces > 1 PR in this window — i.e. the new dedup guard
-- holds under live traffic.

\set ON_ERROR_STOP on

\echo '=== Now ==='
SELECT now() AS validation_at;

\echo ''
\echo '=== A. New findings or seen_count bumps in the last 30 min ==='
SELECT
  count(*) FILTER (WHERE created_at >= now() - interval '30 minutes') AS new_findings_30m,
  count(*) FILTER (WHERE last_seen_at >= now() - interval '30 minutes') AS findings_seen_in_last_30m,
  count(*) FILTER (WHERE last_seen_at >= now() - interval '30 minutes' AND created_at < now() - interval '30 minutes') AS pre_existing_re_seen,
  count(*) FILTER (WHERE status = 'new') AS still_new_total
FROM autopilot_recommendations
WHERE source_type IN ('dev_autopilot', 'dev_autopilot_impact');

\echo ''
\echo '=== B. Executions approved in the last 30 min (KEY METRIC for flood detection) ==='
SELECT
  count(*) AS execs_approved_last_30m,
  count(DISTINCT finding_id) AS distinct_findings_approved,
  count(*) FILTER (WHERE pr_url IS NOT NULL) AS prs_opened_last_30m,
  array_agg(DISTINCT status) AS exec_statuses_seen
FROM dev_autopilot_executions
WHERE approved_at >= now() - interval '30 minutes';

\echo ''
\echo '=== C. PRs per finding for the last 30 min (any > 1 ⇒ flood regression) ==='
WITH x AS (
  SELECT finding_id, count(*) AS exec_count, count(pr_url) AS prs
  FROM dev_autopilot_executions
  WHERE approved_at >= now() - interval '30 minutes'
  GROUP BY finding_id
)
SELECT prs AS prs_per_finding,
       count(*) AS findings_in_bucket,
       array_agg(finding_id) FILTER (WHERE prs > 1) AS finding_ids_with_multiple_prs
FROM x
GROUP BY prs
ORDER BY prs DESC;

\echo ''
\echo '=== D. Guard rejections in the last 30 min (proves the guard FIRED) ==='
-- The guard logs to console when autoApproveTick skips. It does not emit
-- a dedicated OASIS event yet, but the absence of new executions for
-- findings with stranded PRs is the proof. Cross-check with finding count:
SELECT
  count(*) FILTER (WHERE r.status = 'new') AS findings_status_new,
  count(*) FILTER (
    WHERE r.status = 'new'
      AND EXISTS (
        SELECT 1 FROM dev_autopilot_executions e
        WHERE e.finding_id = r.id
          AND e.pr_url IS NOT NULL
          AND e.status NOT IN ('completed', 'self_healed', 'auto_archived')
      )
  ) AS new_findings_with_stranded_pr_blocked_by_guard,
  count(*) FILTER (
    WHERE r.status = 'new'
      AND NOT EXISTS (
        SELECT 1 FROM dev_autopilot_executions e
        WHERE e.finding_id = r.id
          AND e.pr_url IS NOT NULL
          AND e.status NOT IN ('completed', 'self_healed', 'auto_archived')
      )
  ) AS new_findings_clear_to_approve
FROM autopilot_recommendations r
WHERE source_type IN ('dev_autopilot', 'dev_autopilot_impact');

\echo ''
\echo '=== E. OASIS dev_autopilot events in the last 30 min ==='
SELECT created_at, topic, status, left(message, 120) AS message
FROM oasis_events
WHERE topic LIKE 'dev_autopilot.%'
  AND created_at >= now() - interval '30 minutes'
ORDER BY created_at DESC
LIMIT 30;

\echo ''
\echo '=== F. Kill switch + config sanity ==='
SELECT id, kill_switch, daily_budget, concurrency_cap, updated_at
FROM dev_autopilot_config
WHERE id = 1;
