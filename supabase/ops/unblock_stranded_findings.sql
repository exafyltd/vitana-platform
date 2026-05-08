-- Unblock the 5 dev_autopilot findings whose status='new' but whose
-- past executions have stranded PRs (pr_url not null + status not in
-- the "PR was handled" terminal set). The PRs were already closed via
-- the 2026-05-07 bulk-close; this just updates the DB to match.
--
-- After this UPDATE the runExecutionSession + approveAutoExecute guards
-- (PRs #1957 + #1970) will let these findings flow through the pipeline
-- normally. Used to seed the unattended live test.

\set ON_ERROR_STOP on

\echo '=== Stranded executions before unblock ==='
SELECT count(*) AS stranded_execs,
       count(DISTINCT finding_id) AS findings_blocked
FROM dev_autopilot_executions e
JOIN autopilot_recommendations r ON r.id = e.finding_id
WHERE r.source_type = 'dev_autopilot'
  AND r.status = 'new'
  AND e.pr_url IS NOT NULL
  AND e.status NOT IN ('completed', 'self_healed', 'auto_archived');

UPDATE dev_autopilot_executions e
SET status = 'auto_archived',
    metadata = coalesce(e.metadata, '{}'::jsonb) || jsonb_build_object(
      'auto_archived_reason', '2026-05-08 unattended-test seed: PR was bulk-closed on 2026-05-07 during flood cleanup',
      'auto_archived_at', now()
    ),
    updated_at = now()
FROM autopilot_recommendations r
WHERE r.id = e.finding_id
  AND r.source_type = 'dev_autopilot'
  AND r.status = 'new'
  AND e.pr_url IS NOT NULL
  AND e.status NOT IN ('completed', 'self_healed', 'auto_archived');

\echo ''
\echo '=== After unblock: still stranded? ==='
SELECT count(*) AS still_stranded
FROM dev_autopilot_executions e
JOIN autopilot_recommendations r ON r.id = e.finding_id
WHERE r.source_type = 'dev_autopilot'
  AND r.status = 'new'
  AND e.pr_url IS NOT NULL
  AND e.status NOT IN ('completed', 'self_healed', 'auto_archived');
