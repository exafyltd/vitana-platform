-- Check whether the failing findings have spec_snapshot.proposed_files
-- populated. The executor falls back to that when files_referenced is empty;
-- if proposed_files is ALSO empty, the execution fails.

\set ON_ERROR_STOP on

SELECT id,
       status,
       (spec_snapshot->'proposed_files') AS proposed_files,
       coalesce(jsonb_array_length(spec_snapshot->'proposed_files'), 0) AS proposed_files_count
FROM autopilot_recommendations
WHERE id IN (
  'e034a226-fc4b-4fab-b4ae-e52d1b693ea7',
  '05126a44-5ba2-4961-a6a7-06d7e122f915'
);

\echo ''
\echo '=== Broader snooze: any status=new finding whose latest plan has empty files_referenced ==='
\echo '=== regardless of proposed_files (because the executor still emits the same error if extractFilePaths fails) ==='
WITH targets AS (
  SELECT DISTINCT ON (l.finding_id) l.finding_id
  FROM dev_autopilot_plan_versions l
  JOIN autopilot_recommendations r ON r.id = l.finding_id
  WHERE r.source_type = 'dev_autopilot'
    AND r.status = 'new'
    AND coalesce(jsonb_array_length(l.files_referenced), 0) = 0
  ORDER BY l.finding_id, l.version DESC
)
SELECT count(*) AS would_snooze FROM targets;
