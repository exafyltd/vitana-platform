\set ON_ERROR_STOP on

\echo '=== Latest plan for ed4f62b2 (should include package.json now) ==='
SELECT version, files_referenced, length(plan_markdown) AS md_len, created_at,
       left(plan_markdown, 1500) AS plan_excerpt
FROM dev_autopilot_plan_versions
WHERE finding_id = 'ed4f62b2-32a4-487c-b5cb-de091dd3b269'
ORDER BY version DESC
LIMIT 1;
