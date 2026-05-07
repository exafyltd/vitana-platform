-- Why is autoApproveTick silent? Two hypotheses:
-- 1. there's an in-flight execution that's blocking the only viable findings
-- 2. autoApproveTick's full filter set yields 0 candidates

\set ON_ERROR_STOP on

\echo '=== Currently in-flight executions (any non-terminal status) ==='
SELECT id, finding_id, status, pr_url, approved_at, updated_at
FROM dev_autopilot_executions
WHERE status IN ('cooling','running','ci','merging','deploying','verifying')
ORDER BY approved_at DESC
LIMIT 10;

\echo ''
\echo '=== Findings that would pass autoApproveTick (matches its exact filter set) ==='
WITH cfg AS (
  SELECT auto_approve_enabled,
         auto_approve_risk_classes,
         auto_approve_scanners,
         auto_approve_max_effort,
         daily_budget,
         concurrency_cap
  FROM dev_autopilot_config
  WHERE id = 1
)
SELECT r.id, r.title, r.risk_class, r.effort_score, r.impact_score,
       (r.spec_snapshot->>'scanner') AS scanner,
       (SELECT max(version) FROM dev_autopilot_plan_versions p WHERE p.finding_id = r.id) AS plan_version,
       EXISTS (
         SELECT 1 FROM dev_autopilot_executions e
         WHERE e.finding_id = r.id
           AND e.status IN ('cooling','running','ci','merging','deploying','verifying')
       ) AS in_flight,
       EXISTS (
         SELECT 1 FROM dev_autopilot_executions e
         WHERE e.finding_id = r.id
           AND e.pr_url IS NOT NULL
           AND e.status NOT IN ('completed','self_healed','auto_archived')
       ) AS stranded_pr
FROM autopilot_recommendations r, cfg
WHERE r.source_type = 'dev_autopilot'
  AND r.status = 'new'
  AND r.risk_class = ANY (cfg.auto_approve_risk_classes)
  AND r.effort_score <= cfg.auto_approve_max_effort
  AND (r.spec_snapshot->>'scanner') = ANY (cfg.auto_approve_scanners)
  AND EXISTS (SELECT 1 FROM dev_autopilot_plan_versions p WHERE p.finding_id = r.id)
ORDER BY r.impact_score DESC NULLS LAST, r.created_at ASC
LIMIT 10;

\echo ''
\echo '=== Total candidates after each gate (cumulative) ==='
WITH cfg AS (
  SELECT auto_approve_enabled,
         auto_approve_risk_classes,
         auto_approve_scanners,
         auto_approve_max_effort
  FROM dev_autopilot_config
  WHERE id = 1
)
SELECT
  (SELECT count(*) FROM autopilot_recommendations r WHERE r.source_type='dev_autopilot' AND r.status='new') AS step1_status_new,
  (SELECT count(*) FROM autopilot_recommendations r, cfg WHERE r.source_type='dev_autopilot' AND r.status='new' AND r.risk_class = ANY (cfg.auto_approve_risk_classes)) AS step2_plus_risk,
  (SELECT count(*) FROM autopilot_recommendations r, cfg WHERE r.source_type='dev_autopilot' AND r.status='new' AND r.risk_class = ANY (cfg.auto_approve_risk_classes) AND r.effort_score <= cfg.auto_approve_max_effort) AS step3_plus_effort,
  (SELECT count(*) FROM autopilot_recommendations r, cfg WHERE r.source_type='dev_autopilot' AND r.status='new' AND r.risk_class = ANY (cfg.auto_approve_risk_classes) AND r.effort_score <= cfg.auto_approve_max_effort AND (r.spec_snapshot->>'scanner') = ANY (cfg.auto_approve_scanners)) AS step4_plus_scanner;
