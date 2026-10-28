-- 20260106000000_add_oasis_only_task_truth_rule.sql
-- VTID-01160: Governance Validator — OASIS_ONLY_TASK_TRUTH
--
-- HARD GOVERNANCE (NON-NEGOTIABLE):
-- This migration adds the GOV-INTEL-R.1 governance rule that enforces
-- OASIS as the ONLY source of truth for task state queries.
--
-- Rule ID: GOV-INTEL-R.1
-- Name: OASIS_ONLY_TASK_TRUTH
-- Severity: CRITICAL
-- Applies to: ORB, Operator Console, MCP tool callers
-- Trigger: TASK_STATE_QUERY intent
--
-- Rule Statements:
-- 1. Source of truth for task state MUST be OASIS
-- 2. Allowed discovery tool: mcp__vitana-work__discover_tasks only
-- 3. Task identifiers MUST match ^VTID-\d{4,5}$
-- 4. DEV-/ADM-/AICOR-* may only appear in ignored[] as legacy artifacts

DO $$
DECLARE
  v_tenant_id text := 'SYSTEM';
  v_category_id uuid;
BEGIN

  -- 1) Ensure TASK_DISCOVERY_GOVERNANCE category exists
  INSERT INTO governance_categories (tenant_id, name, description, severity)
  VALUES (
    v_tenant_id,
    'TASK_DISCOVERY_GOVERNANCE',
    'Rules enforcing OASIS as the single source of truth for task state queries. Hard governance rules that block non-compliant task discovery attempts.'
    , 1  -- Severity 1 = CRITICAL
  )
  ON CONFLICT (tenant_id, name) DO UPDATE
  SET description = EXCLUDED.description,
      severity = EXCLUDED.severity
  RETURNING id INTO v_category_id;

  -- Fallback if no update happened
  IF v_category_id IS NULL THEN
    SELECT id INTO v_category_id
    FROM governance_categories
    WHERE tenant_id = v_tenant_id AND name = 'TASK_DISCOVERY_GOVERNANCE';
  END IF;

  -- 2) Add GOV-INTEL-R.1 - OASIS_ONLY_TASK_TRUTH rule
  IF NOT EXISTS (SELECT 1 FROM governance_rules WHERE tenant_id = v_tenant_id AND logic->>'rule_code' = 'GOV-INTEL-R.1') THEN
    INSERT INTO governance_rules (tenant_id, category_id, name, description, is_active, logic)
    VALUES (
      v_tenant_id,
      v_category_id,
      'OASIS_ONLY_TASK_TRUTH',
      'HARD GOVERNANCE: Source of truth for task state MUST be OASIS. All task-status queries MUST use mcp__vitana-work__discover_tasks. Task identifiers MUST match VTID-\d{4,5}. Legacy patterns (DEV-*, ADM-*, AICOR-*) are blocked in pending lists.',
      TRUE,
      '{
        "rule_code": "GOV-INTEL-R.1",
        "type": "hard_gate",
        "severity": "CRITICAL",
        "trigger": "TASK_STATE_QUERY",
        "applies_to": ["orb", "operator", "mcp"],
        "enforcement": {
          "action": "BLOCK",
          "emit_event": "governance.violation.oasis_only_task_truth",
          "user_message": "Blocked by governance: task status must come from OASIS.",
          "retry_action": "discover_tasks_required"
        },
        "validation": {
          "source_of_truth": "OASIS",
          "allowed_tool": "mcp__vitana-work__discover_tasks",
          "vtid_pattern": "^VTID-\\d{4,5}$",
          "legacy_patterns_blocked": ["^DEV-", "^ADM-", "^AICOR-", "^OASIS-TASK-"],
          "allowed_pending_statuses": ["scheduled", "allocated", "in_progress"]
        },
        "vtid": "VTID-01160"
      }'::jsonb
    );
  ELSE
    -- Update existing rule to ensure it matches current spec
    UPDATE governance_rules
    SET
      name = 'OASIS_ONLY_TASK_TRUTH',
      description = 'HARD GOVERNANCE: Source of truth for task state MUST be OASIS. All task-status queries MUST use mcp__vitana-work__discover_tasks. Task identifiers MUST match VTID-\d{4,5}. Legacy patterns (DEV-*, ADM-*, AICOR-*) are blocked in pending lists.',
      is_active = TRUE,
      logic = '{
        "rule_code": "GOV-INTEL-R.1",
        "type": "hard_gate",
        "severity": "CRITICAL",
        "trigger": "TASK_STATE_QUERY",
        "applies_to": ["orb", "operator", "mcp"],
        "enforcement": {
          "action": "BLOCK",
          "emit_event": "governance.violation.oasis_only_task_truth",
          "user_message": "Blocked by governance: task status must come from OASIS.",
          "retry_action": "discover_tasks_required"
        },
        "validation": {
          "source_of_truth": "OASIS",
          "allowed_tool": "mcp__vitana-work__discover_tasks",
          "vtid_pattern": "^VTID-\\d{4,5}$",
          "legacy_patterns_blocked": ["^DEV-", "^ADM-", "^AICOR-", "^OASIS-TASK-"],
          "allowed_pending_statuses": ["scheduled", "allocated", "in_progress"]
        },
        "vtid": "VTID-01160"
      }'::jsonb
    WHERE tenant_id = v_tenant_id AND logic->>'rule_code' = 'GOV-INTEL-R.1';
  END IF;

  -- 3) Log the migration event
  RAISE NOTICE 'VTID-01160: GOV-INTEL-R.1 (OASIS_ONLY_TASK_TRUTH) governance rule created/updated successfully';

END $$;

-- Add comment to document the rule
COMMENT ON TABLE governance_rules IS 'Governance rules table. Includes VTID-01160 GOV-INTEL-R.1 OASIS_ONLY_TASK_TRUTH hard gate rule.';
