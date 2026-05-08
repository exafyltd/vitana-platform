-- Broader snooze: any status='new' dev_autopilot finding whose LATEST plan
-- has files_referenced=[]. Doesn't check proposed_files because if
-- extractFilePaths(plan_markdown) returns 0 hits AND files_referenced=[],
-- the executor still errors with "plan has no files_referenced".

\set ON_ERROR_STOP on

WITH targets AS (
  SELECT DISTINCT ON (l.finding_id) l.finding_id
  FROM dev_autopilot_plan_versions l
  JOIN autopilot_recommendations r ON r.id = l.finding_id
  WHERE r.source_type = 'dev_autopilot'
    AND r.status = 'new'
    AND coalesce(jsonb_array_length(l.files_referenced), 0) = 0
  ORDER BY l.finding_id, l.version DESC
)
UPDATE autopilot_recommendations r
SET status = 'snoozed',
    snoozed_until = (now() + interval '30 days')::timestamptz,
    updated_at = now()
FROM targets
WHERE r.id = targets.finding_id
  AND r.status = 'new';

\echo ''
\echo '=== All findings now in 30-day snooze ==='
SELECT id, status, snoozed_until, left(title, 80) AS title
FROM autopilot_recommendations
WHERE source_type = 'dev_autopilot'
  AND status = 'snoozed'
  AND snoozed_until > now() + interval '29 days';
