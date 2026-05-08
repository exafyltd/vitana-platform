-- Inspect why finding e034a226 keeps failing at "plan has no files_referenced"

\set ON_ERROR_STOP on

\echo '=== Finding row ==='
SELECT id, status, title, risk_class, effort_score, impact_score,
       (spec_snapshot->>'scanner') AS scanner,
       spec_snapshot->'proposed_files' AS proposed_files,
       jsonb_pretty(spec_snapshot) AS spec
FROM autopilot_recommendations
WHERE id = 'e034a226-fc4b-4fab-b4ae-e52d1b693ea7';

\echo ''
\echo '=== All plan versions for this finding ==='
SELECT version, files_referenced,
       jsonb_array_length(files_referenced) AS files_count,
       length(plan_markdown) AS md_len,
       created_at
FROM dev_autopilot_plan_versions
WHERE finding_id = 'e034a226-fc4b-4fab-b4ae-e52d1b693ea7'
ORDER BY version;

\echo ''
\echo '=== Latest plan_markdown excerpt ==='
SELECT version, left(plan_markdown, 1500) AS excerpt
FROM dev_autopilot_plan_versions
WHERE finding_id = 'e034a226-fc4b-4fab-b4ae-e52d1b693ea7'
ORDER BY version DESC
LIMIT 1;

\echo ''
\echo '=== Recent executions for this finding ==='
SELECT id, plan_version, status, pr_url, approved_at, metadata->>'error' AS error
FROM dev_autopilot_executions
WHERE finding_id = 'e034a226-fc4b-4fab-b4ae-e52d1b693ea7'
ORDER BY approved_at DESC
LIMIT 5;
