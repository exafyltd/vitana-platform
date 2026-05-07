-- Why are 216 'new' findings producing 0 executions when the kill switch is
-- off, the daily budget has 500 slots, and only 2 findings have stranded PRs?
-- Trace through every gate autoApproveTick checks.

\set ON_ERROR_STOP on

\echo '=== Full config ==='
SELECT id,
       kill_switch,
       auto_approve_enabled,
       auto_approve_risk_classes,
       auto_approve_scanners,
       auto_approve_max_effort,
       daily_budget,
       concurrency_cap,
       max_auto_fix_depth,
       updated_at
FROM dev_autopilot_config
WHERE id = 1;

\echo ''
\echo '=== Findings funnel: from status=new down to "would auto-approve" ==='
WITH base AS (
  SELECT r.id, r.risk_class, r.effort_score,
         (r.spec_snapshot->>'scanner') AS scanner,
         (SELECT max(version) FROM dev_autopilot_plan_versions p WHERE p.finding_id = r.id) AS latest_plan_version,
         EXISTS (
           SELECT 1 FROM dev_autopilot_executions e
           WHERE e.finding_id = r.id
             AND e.status IN ('cooling','running','ci','merging','deploying','verifying')
         ) AS has_inflight,
         EXISTS (
           SELECT 1 FROM dev_autopilot_executions e
           WHERE e.finding_id = r.id
             AND e.pr_url IS NOT NULL
             AND e.status NOT IN ('completed','self_healed','auto_archived')
         ) AS has_stranded_pr
  FROM autopilot_recommendations r
  WHERE r.source_type = 'dev_autopilot'
    AND r.status = 'new'
)
SELECT
  count(*) AS status_new,
  count(*) FILTER (WHERE risk_class IN ('low','medium')) AS risk_low_or_medium,
  count(*) FILTER (WHERE risk_class IN ('low','medium') AND effort_score <= 5) AS effort_le_5,
  count(*) FILTER (WHERE latest_plan_version IS NOT NULL) AS has_a_plan,
  count(*) FILTER (
    WHERE risk_class IN ('low','medium')
      AND effort_score <= 5
      AND latest_plan_version IS NOT NULL
  ) AS plan_AND_low_effort_AND_low_risk,
  count(*) FILTER (
    WHERE risk_class IN ('low','medium')
      AND effort_score <= 5
      AND latest_plan_version IS NOT NULL
      AND NOT has_inflight
      AND NOT has_stranded_pr
  ) AS would_auto_approve_today
FROM base;

\echo ''
\echo '=== Of those that would auto-approve, top 10 by impact_score ==='
SELECT r.id, r.risk_class, r.effort_score, r.impact_score,
       (r.spec_snapshot->>'scanner') AS scanner,
       left(r.title, 70) AS title
FROM autopilot_recommendations r
WHERE r.source_type = 'dev_autopilot'
  AND r.status = 'new'
  AND r.risk_class IN ('low','medium')
  AND r.effort_score <= 5
  AND EXISTS (SELECT 1 FROM dev_autopilot_plan_versions p WHERE p.finding_id = r.id)
  AND NOT EXISTS (
    SELECT 1 FROM dev_autopilot_executions e
    WHERE e.finding_id = r.id
      AND (e.status IN ('cooling','running','ci','merging','deploying','verifying')
        OR (e.pr_url IS NOT NULL AND e.status NOT IN ('completed','self_healed','auto_archived')))
  )
ORDER BY r.impact_score DESC NULLS LAST, r.created_at ASC
LIMIT 10;

\echo ''
\echo '=== Scanner distribution among status=new findings ==='
SELECT (spec_snapshot->>'scanner') AS scanner, count(*) AS findings
FROM autopilot_recommendations
WHERE source_type = 'dev_autopilot'
  AND status = 'new'
GROUP BY 1
ORDER BY 2 DESC;
