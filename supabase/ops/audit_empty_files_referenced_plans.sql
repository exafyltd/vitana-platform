-- Audit plans with empty/missing files_referenced. R2-real showed all 5
-- approved executions failed at "plan has no files_referenced — cannot
-- execute". This blocks the autopilot from doing real work even after
-- the flood guards land.

\set ON_ERROR_STOP on

\echo '=== Plan-version stats ==='
SELECT
  count(*) AS total_plan_versions,
  count(*) FILTER (WHERE coalesce(array_length(files_referenced, 1), 0) = 0) AS plans_with_zero_files,
  count(*) FILTER (WHERE coalesce(array_length(files_referenced, 1), 0) BETWEEN 1 AND 5) AS plans_with_1_to_5_files,
  count(*) FILTER (WHERE coalesce(array_length(files_referenced, 1), 0) > 5) AS plans_with_more_than_5_files
FROM dev_autopilot_plan_versions;

\echo ''
\echo '=== Findings whose LATEST plan has zero files_referenced ==='
WITH latest AS (
  SELECT DISTINCT ON (finding_id) finding_id, version, files_referenced, plan_markdown
  FROM dev_autopilot_plan_versions
  ORDER BY finding_id, version DESC
)
SELECT
  count(*) AS total_findings_with_plans,
  count(*) FILTER (WHERE coalesce(array_length(files_referenced, 1), 0) = 0) AS findings_whose_latest_plan_has_zero_files,
  count(*) FILTER (WHERE plan_markdown IS NULL OR plan_markdown = '') AS findings_whose_plan_markdown_is_empty
FROM latest;

\echo ''
\echo '=== Top 10 status=new findings whose latest plan has zero files_referenced ==='
WITH latest AS (
  SELECT DISTINCT ON (finding_id) finding_id, version, files_referenced, plan_markdown, created_at AS plan_created
  FROM dev_autopilot_plan_versions
  ORDER BY finding_id, version DESC
)
SELECT r.id AS finding_id,
       left(r.title, 80) AS title,
       r.spec_snapshot->>'scanner' AS scanner,
       l.version AS plan_version,
       length(l.plan_markdown) AS plan_md_len,
       l.plan_created
FROM autopilot_recommendations r
JOIN latest l ON l.finding_id = r.id
WHERE r.source_type = 'dev_autopilot'
  AND r.status = 'new'
  AND coalesce(array_length(l.files_referenced, 1), 0) = 0
ORDER BY r.impact_score DESC NULLS LAST, l.plan_created DESC
LIMIT 10;

\echo ''
\echo '=== Sample plan_markdown for one offender (to see what the planner emitted) ==='
WITH latest AS (
  SELECT DISTINCT ON (finding_id) finding_id, version, files_referenced, plan_markdown
  FROM dev_autopilot_plan_versions
  ORDER BY finding_id, version DESC
)
SELECT r.id AS finding_id,
       r.title,
       r.spec_snapshot->>'scanner' AS scanner,
       r.spec_snapshot->'proposed_files' AS spec_proposed_files,
       l.files_referenced,
       left(l.plan_markdown, 1500) AS plan_md_excerpt
FROM autopilot_recommendations r
JOIN latest l ON l.finding_id = r.id
WHERE r.source_type = 'dev_autopilot'
  AND r.status = 'new'
  AND coalesce(array_length(l.files_referenced, 1), 0) = 0
ORDER BY r.impact_score DESC NULLS LAST
LIMIT 2;
