-- 20251125000001_add_auto_merge_governance_rules.sql
-- DEV-CICDL-0207 – Autonomous Safe Merge Layer (Phase 1)
--
-- Creates AUTO_MERGE_GOVERNANCE category and rules for autonomous PR merging.
-- Rules: AUTO-MERGE-001 through AUTO-MERGE-005
--
-- Schema:
--   governance_categories(id, tenant_id, name, description, ...)
--   governance_rules(id, tenant_id, category_id, name, description, logic, is_active, ...)

DO $$
DECLARE
  v_tenant_id text := 'SYSTEM';
  v_category_id uuid;
BEGIN

  -- 1) Create AUTO_MERGE_GOVERNANCE category
  INSERT INTO governance_categories (tenant_id, name, description, severity)
  VALUES (
    v_tenant_id,
    'AUTO_MERGE_GOVERNANCE',
    'Rules governing autonomous PR merging. PRs meeting all criteria can be auto-merged by CI/CD without human intervention.',
    2  -- High severity
  )
  ON CONFLICT (tenant_id, name) DO UPDATE
  SET description = EXCLUDED.description,
      severity = EXCLUDED.severity
  RETURNING id INTO v_category_id;

  -- Fallback if no update happened
  IF v_category_id IS NULL THEN
    SELECT id INTO v_category_id
    FROM governance_categories
    WHERE tenant_id = v_tenant_id AND name = 'AUTO_MERGE_GOVERNANCE';
  END IF;

  -- 2) Create AUTO-MERGE-001: Allowed Modules List
  IF NOT EXISTS (SELECT 1 FROM governance_rules WHERE tenant_id = v_tenant_id AND logic->>'rule_code' = 'AUTO-MERGE-001') THEN
    INSERT INTO governance_rules (tenant_id, category_id, name, description, is_active, logic)
    VALUES (
      v_tenant_id,
      v_category_id,
      'Allowed Modules List',
      'Only PRs for allowed modules may be auto-merged. Allowed modules: CICDL, GATEWAY, OASIS, VTID_GOVERNANCE. PRs touching other modules require human review.',
      TRUE,
      '{
        "rule_code": "AUTO-MERGE-001",
        "type": "auto_merge",
        "op": "contains",
        "field": "module",
        "value": ["CICDL", "GATEWAY", "OASIS", "VTID_GOVERNANCE"],
        "action": "BLOCK",
        "action_reason": "Module not in allowed auto-merge list"
      }'::jsonb
    );
  END IF;

  -- 3) Create AUTO-MERGE-002: CI Must Be Green
  IF NOT EXISTS (SELECT 1 FROM governance_rules WHERE tenant_id = v_tenant_id AND logic->>'rule_code' = 'AUTO-MERGE-002') THEN
    INSERT INTO governance_rules (tenant_id, category_id, name, description, is_active, logic)
    VALUES (
      v_tenant_id,
      v_category_id,
      'CI Must Be Green',
      'PR cannot be auto-merged unless all GitHub Actions workflows pass. No lint failures, no test failures, no build failures allowed.',
      TRUE,
      '{
        "rule_code": "AUTO-MERGE-002",
        "type": "auto_merge",
        "op": "eq",
        "field": "ci_status",
        "value": "success",
        "action": "BLOCK",
        "action_reason": "CI checks not passing"
      }'::jsonb
    );
  END IF;

  -- 4) Create AUTO-MERGE-003: Validator Approval Required
  IF NOT EXISTS (SELECT 1 FROM governance_rules WHERE tenant_id = v_tenant_id AND logic->>'rule_code' = 'AUTO-MERGE-003') THEN
    INSERT INTO governance_rules (tenant_id, category_id, name, description, is_active, logic)
    VALUES (
      v_tenant_id,
      v_category_id,
      'Validator Approval Required',
      'Validator-core must return a PASS event for the PR. The validator checks for security issues, governance violations, and forbidden changes.',
      TRUE,
      '{
        "rule_code": "AUTO-MERGE-003",
        "type": "auto_merge",
        "op": "eq",
        "field": "validator_status",
        "value": "success",
        "action": "BLOCK",
        "action_reason": "Validator has not approved this PR"
      }'::jsonb
    );
  END IF;

  -- 5) Create AUTO-MERGE-004: OASIS PR Status Tracking Required
  IF NOT EXISTS (SELECT 1 FROM governance_rules WHERE tenant_id = v_tenant_id AND logic->>'rule_code' = 'AUTO-MERGE-004') THEN
    INSERT INTO governance_rules (tenant_id, category_id, name, description, is_active, logic)
    VALUES (
      v_tenant_id,
      v_category_id,
      'OASIS PR Status Tracking Required',
      'Every PR must generate and update status events in OASIS: PR_CREATED, PR_VALIDATED, PR_READY_TO_MERGE, PR_MERGED, PR_BLOCKED. If any required events are missing, auto-merge is forbidden.',
      TRUE,
      '{
        "rule_code": "AUTO-MERGE-004",
        "type": "auto_merge",
        "op": "eq",
        "field": "oasis_tracking",
        "value": true,
        "action": "BLOCK",
        "action_reason": "Required OASIS PR events not found"
      }'::jsonb
    );
  END IF;

  -- 6) Create AUTO-MERGE-005: Human Override Option
  IF NOT EXISTS (SELECT 1 FROM governance_rules WHERE tenant_id = v_tenant_id AND logic->>'rule_code' = 'AUTO-MERGE-005') THEN
    INSERT INTO governance_rules (tenant_id, category_id, name, description, is_active, logic)
    VALUES (
      v_tenant_id,
      v_category_id,
      'Human Override Option',
      'If override: true is set in PR metadata (via label or comment), auto-merge is disabled. This allows human review to be enforced when needed.',
      TRUE,
      '{
        "rule_code": "AUTO-MERGE-005",
        "type": "auto_merge",
        "op": "neq",
        "field": "override",
        "value": true,
        "action": "BLOCK",
        "action_reason": "Human override flag is set - requires manual merge"
      }'::jsonb
    );
  END IF;

  RAISE NOTICE 'AUTO_MERGE_GOVERNANCE category and rules created/updated successfully';

END $$;
