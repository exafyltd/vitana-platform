-- Snooze the 8 status='new' findings whose latest plan has zero
-- files_referenced AND no spec_proposed_files. Without snoozing, every
-- autoApproveTick wastes a slot approving these only for
-- runExecutionSession to fail at "plan has no files_referenced".
--
-- Snooze for 30 days — long enough to deprioritise without erasing.
-- Operator can manually unsnooze after the planner audit lands.
--
-- Idempotent: re-running just bumps snoozed_until.

\set ON_ERROR_STOP on

WITH targets AS (
  SELECT DISTINCT ON (l.finding_id) l.finding_id
  FROM dev_autopilot_plan_versions l
  JOIN autopilot_recommendations r ON r.id = l.finding_id
  WHERE r.source_type = 'dev_autopilot'
    AND r.status = 'new'
    AND coalesce(jsonb_array_length(l.files_referenced), 0) = 0
    AND (
      r.spec_snapshot->'proposed_files' IS NULL
      OR jsonb_array_length(r.spec_snapshot->'proposed_files') = 0
    )
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
\echo '=== Findings just snoozed ==='
SELECT id, status, snoozed_until, left(title, 80) AS title
FROM autopilot_recommendations
WHERE source_type = 'dev_autopilot'
  AND status = 'snoozed'
  AND snoozed_until > now() + interval '29 days';
