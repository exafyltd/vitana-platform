-- VTID-04319 — Orchestrator v2 P1 (docs/ORCHESTRATOR-REDESIGN-PLAN.md §3.3, §3.5)
--
-- Additive only. Nothing existing is altered in a way that changes behaviour:
--   1. agents_registry gains nullable agent-card columns (+ enabled default true).
--   2. agent_runs / agent_run_steps / agent_run_signals: the native run ledger,
--      empty until a plane writes to it natively (P4).
--   3. agent_runs_unified: a read-only VIEW projecting the three existing run
--      tables (Dev Autopilot executions, community AP automation runs,
--      self-healing attempts) plus native agent_runs into one generic shape.
--      This is the P1 "projection": no plane writes anything new.
-- All three tables and the view are service-role only (RLS on, no policies,
-- anon/authenticated revoked). The gateway reads them with the service key.

-- 1. Agent Registry v2 — agent cards ---------------------------------------
ALTER TABLE agents_registry
  ADD COLUMN IF NOT EXISTS skills             text[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS domains            text[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS roles_allowed      text[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS surfaces_allowed   text[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS llm_stage          text,
  ADD COLUMN IF NOT EXISTS max_tier           text,
  ADD COLUMN IF NOT EXISTS budget_per_run_usd numeric(10,4),
  ADD COLUMN IF NOT EXISTS budget_per_day_usd numeric(10,4),
  ADD COLUMN IF NOT EXISTS owner              text,
  ADD COLUMN IF NOT EXISTS eval_suite         text,
  ADD COLUMN IF NOT EXISTS eval_pass_rate     numeric(5,4),
  ADD COLUMN IF NOT EXISTS enabled            boolean NOT NULL DEFAULT true;

DO $$ BEGIN
  ALTER TABLE agents_registry ADD CONSTRAINT agents_registry_max_tier_chk
    CHECK (max_tier IS NULL OR max_tier IN ('read','draft','commit','high'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Native run ledger ------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_run_id    uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  root_run_id      uuid,
  agent_id         text NOT NULL,
  plane            text NOT NULL,
  principal        jsonb NOT NULL DEFAULT '{}'::jsonb,
  user_id          uuid,
  tenant_id        uuid,
  vtid             text,
  intent           text,
  status           text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','running','waiting_signal','awaiting_approval','succeeded','failed','cancelled')),
  tier             text CHECK (tier IS NULL OR tier IN ('read','draft','commit','high')),
  idempotency_key  text UNIQUE,
  budget_usd       numeric(10,4),
  spent_usd        numeric(10,4) NOT NULL DEFAULT 0,
  lease_owner      text,
  lease_until      timestamptz,
  created_via      text CHECK (created_via IS NULL OR created_via IN ('voice','chat','web','scheduler','event','ci','system')),
  deliver_to       jsonb,
  result_ref       jsonb,
  error            text,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status_created ON agent_runs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_created  ON agent_runs (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_root           ON agent_runs (root_run_id);

CREATE TABLE IF NOT EXISTS agent_run_steps (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id      uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  seq         integer NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('model_call','tool_call','observation','progress','note')),
  name        text,
  progress    boolean,
  looping     boolean,
  input       jsonb,
  output      jsonb,
  tokens_in   integer,
  tokens_out  integer,
  cost_usd    numeric(10,6),
  duration_ms integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);

CREATE TABLE IF NOT EXISTS agent_run_signals (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id      uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('approval','rejection','ci_result','cancel','user_reply','timeout')),
  actor       text,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_run_signals_run ON agent_run_signals (run_id, created_at);

ALTER TABLE agent_runs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_run_steps   ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_run_signals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON agent_runs, agent_run_steps, agent_run_signals FROM anon, authenticated;

-- 3. Projection: every plane's runs in one generic shape -------------------
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
FROM agent_runs n;

REVOKE ALL ON agent_runs_unified FROM anon, authenticated;

COMMENT ON VIEW agent_runs_unified IS
  'VTID-04319: Orchestrator v2 run ledger projection over dev_autopilot_executions, automation_runs, self_healing_log and native agent_runs. Read-only; service role.';
COMMENT ON TABLE agent_runs IS
  'VTID-04319: Orchestrator v2 native run ledger (docs/ORCHESTRATOR-REDESIGN-PLAN.md §3.3). Empty until a plane writes natively (P4).';

-- 4. Registry v2 seed: facts already recorded in docs/AGENT-REGISTRY.md -------
-- Retired in VTID-04318 (source removed): kept as rows for history, disabled.
UPDATE agents_registry
   SET enabled = false,
       metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('retired_by', 'VTID-04318', 'retired_reason', 'source removed; no deploy path, no callers'),
       updated_at = now()
 WHERE agent_id IN ('conductor', 'crewai-gcp', 'validator-core');

-- Agent-card fields for agents whose stage is established (llm_routing_policy v17).
UPDATE agents_registry SET llm_stage = 'triage',   domains = '{dev,ops}', max_tier = 'read',   owner = 'platform', updated_at = now() WHERE agent_id = 'architecture-investigator';
UPDATE agents_registry SET llm_stage = 'operator', domains = '{dev,ops}', max_tier = 'commit', owner = 'platform', surfaces_allowed = '{command-hub}', roles_allowed = '{developer,admin}', updated_at = now() WHERE agent_id = 'gemini-operator';
UPDATE agents_registry SET llm_stage = 'planner',  domains = '{dev}',     max_tier = 'commit', owner = 'platform', updated_at = now() WHERE agent_id = 'dev-autopilot';
UPDATE agents_registry SET llm_stage = 'triage',   domains = '{ops}',     max_tier = 'read',   owner = 'platform', updated_at = now() WHERE agent_id = 'voice-triage-agent';
UPDATE agents_registry SET domains = '{community,health,admin,backoffice,dev}', surfaces_allowed = '{vitanaland,admin,backoffice,command-hub}', max_tier = 'draft', owner = 'platform', updated_at = now() WHERE agent_id = 'orb-live';

-- Agents that run today but were never registered (docs/AGENT-REGISTRY.md §2).
INSERT INTO agents_registry (agent_id, display_name, description, tier, role, llm_provider, llm_model, source_path, status, llm_stage, domains, max_tier, owner, metadata)
VALUES
  ('autopilot-agent-executor', 'Dev Autopilot agent executor', 'Tool-loop code agent on the ECS executor task (VTID-04006).', 'service', 'executor', 'deepseek', 'deepseek-flash', 'services/gateway/src/services/autopilot-agent/', 'unknown', 'worker', '{dev}', 'commit', 'platform', '{"registered_by":"VTID-04319"}'),
  ('self-healing-triage', 'Self-healing triage', 'Root-cause triage with read-only tools (VTID-04232).', 'embedded', 'triage', 'claude', 'eu.anthropic.claude-sonnet-4-6', 'services/gateway/src/services/self-healing-triage-service.ts', 'unknown', 'triage', '{dev,ops}', 'read', 'platform', '{"registered_by":"VTID-04319"}'),
  ('llm-merge-validator', 'LLM merge review', 'Pre-merge validator for Dev Autopilot PRs (VTID-03853/04231).', 'embedded', 'validation', 'claude', 'eu.anthropic.claude-opus-4-5-20251101-v1:0', 'services/gateway/src/services/dev-autopilot-llm-review.ts', 'unknown', 'validator', '{dev}', 'read', 'platform', '{"registered_by":"VTID-04319"}'),
  ('spec-generator', 'Spec generator', 'Planner-stage spec generation with codebase-index tools (VTID-04233).', 'embedded', 'planner', 'claude', 'eu.anthropic.claude-opus-4-5-20251101-v1:0', 'services/gateway/src/routes/specs.ts', 'unknown', 'planner', '{dev}', 'draft', 'platform', '{"registered_by":"VTID-04319"}'),
  ('backoffice-command-orchestrator', 'BackOffice command orchestrator', 'Typed ERP command registry, policy tiers and maker-checker (VTID-03842).', 'embedded', 'orchestrator', 'none', NULL, 'services/gateway/src/services/backoffice/', 'unknown', NULL, '{backoffice,commerce}', 'high', 'platform', '{"registered_by":"VTID-04319"}')
ON CONFLICT (agent_id) DO NOTHING;
