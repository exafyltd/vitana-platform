-- VTID-04446 — Orchestrator v2 P4: run leases (docs/ORCHESTRATOR-REDESIGN-PLAN.md §3.3, §5 P4)
--
-- NOT APPLIED. This file ships with the code; the platform owner applies it.
-- Apply it BEFORE setting ORCHESTRATOR_RUN_LEASE_ENABLED=true on any stack.
--
-- Additive only:
--   1. A partial index for the two lease scans the gateway runs every tick:
--      "leases of these executions" (idempotency_key, already UNIQUE-indexed)
--      and "expired running leases" (this index).
--   2. agent_runs_unified re-created with ONE change: native rows that are a
--      lease mirror of a Dev Autopilot execution (metadata.mirror_of set) are
--      excluded. The execution already appears through its own projection;
--      without this filter every leased execution would be listed twice.
--      Every column, alias and branch is otherwise identical to VTID-04319.
--
-- No table is created or altered; no row is written. With the flag off the
-- code never reads or writes agent_runs for leases, so applying this changes
-- nothing observable except the view's filter (which matches no row today:
-- agent_runs holds only delegation jobs, none with metadata.mirror_of).

CREATE INDEX IF NOT EXISTS idx_agent_runs_running_lease
  ON agent_runs (lease_until)
  WHERE status = 'running' AND lease_until IS NOT NULL;

CREATE OR REPLACE VIEW agent_runs_unified WITH (security_invoker = true) AS
SELECT
  'dev_autopilot:' || e.id::text                         AS run_key,
  'dev_autopilot'::text                                  AS plane,
  COALESCE(e.metadata->>'executor', 'dev-autopilot-executor') AS agent_id,
  e.id::text                                             AS source_id,
  CASE
    WHEN e.status IN ('completed','self_healed')                       THEN 'succeeded'
    WHEN e.status IN ('failed','failed_escalated','reverted')          THEN 'failed'
    WHEN e.status IN ('cancelled','rejected','archived','auto_archived') THEN 'cancelled'
    WHEN e.status = 'awaiting_approval'                                THEN 'awaiting_approval'
    WHEN e.status = 'cooling'                                          THEN 'queued'
    WHEN e.status IN ('ci','merging','deploying','verifying')          THEN 'waiting_signal'
    ELSE 'running'
  END                                                    AS status,
  e.status                                               AS source_status,
  COALESCE(r.activated_vtid, e.self_healing_vtid)        AS vtid,
  NULL::uuid                                             AS tenant_id,
  NULL::uuid                                             AS user_id,
  CASE WHEN e.parent_execution_id IS NOT NULL THEN 'dev_autopilot:' || e.parent_execution_id::text END AS parent_run_key,
  COALESCE(r.source_type, 'dev_autopilot')               AS created_via,
  LEFT(r.title, 200)                                     AS title,
  e.metadata->>'error'                                   AS error,
  e.pr_url                                               AS result_ref,
  e.created_at,
  e.updated_at,
  e.completed_at
FROM dev_autopilot_executions e
LEFT JOIN autopilot_recommendations r ON r.id = e.finding_id
UNION ALL
SELECT
  'community_autopilot:' || a.id::text,
  'community_autopilot',
  a.automation_id,
  a.id::text,
  CASE
    WHEN a.status = 'completed' THEN 'succeeded'
    WHEN a.status = 'failed'    THEN 'failed'
    WHEN a.status IN ('skipped','cancelled') THEN 'cancelled'
    ELSE 'running'
  END,
  a.status,
  NULL,
  a.tenant_id,
  NULL,
  NULL,
  COALESCE(a.trigger_type, 'scheduler'),
  a.automation_id,
  a.error_message,
  NULL,
  a.created_at,
  COALESCE(a.completed_at, a.started_at, a.created_at),
  a.completed_at
FROM automation_runs a
UNION ALL
SELECT
  'self_healing:' || s.id::text,
  'self_healing',
  'self-healing',
  s.id::text,
  CASE
    WHEN s.outcome IN ('fixed','resolved','success')            THEN 'succeeded'
    WHEN s.outcome IN ('failed','rolled_back','escalated','error') THEN 'failed'
    WHEN s.resolved_at IS NOT NULL                                 THEN 'succeeded'
    ELSE 'running'
  END,
  s.outcome,
  s.vtid,
  NULL,
  NULL,
  NULL,
  'event',
  LEFT(COALESCE(s.failure_class, '') || ' ' || COALESCE(s.endpoint, ''), 200),
  NULL,
  NULL,
  s.created_at,
  COALESCE(s.resolved_at, s.created_at),
  s.resolved_at
FROM self_healing_log s
UNION ALL
SELECT
  'native:' || n.id::text,
  n.plane,
  n.agent_id,
  n.id::text,
  n.status,
  n.status,
  n.vtid,
  n.tenant_id,
  n.user_id,
  CASE WHEN n.parent_run_id IS NOT NULL THEN 'native:' || n.parent_run_id::text END,
  n.created_via,
  LEFT(n.intent, 200),
  n.error,
  n.result_ref->>'url',
  n.created_at,
  n.updated_at,
  n.completed_at
FROM agent_runs n
WHERE n.metadata->'mirror_of' IS NULL;

REVOKE ALL ON agent_runs_unified FROM anon, authenticated;

COMMENT ON VIEW agent_runs_unified IS
  'VTID-04319/VTID-04446: Orchestrator v2 run ledger projection over dev_autopilot_executions, automation_runs, self_healing_log and native agent_runs (lease mirrors excluded). Read-only; service role.';
