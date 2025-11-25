-- 20251120232139_oasis_gov_0108_rules_seed_fixed.sql
-- DEV-OASIS-GOV-0108 — Seed Vitana Governance Rules Library (FIXED)
-- 
-- Purpose: Insert comprehensive governance rules across all categories
-- Dependencies: Migrations 0101 (schema), 0102 (categories), 0103 (MG rules)
-- Follows: MG-001 (Idempotent SQL Requirement)
--
-- FIX: Uses EXISTS checks instead of ON CONFLICT on non-existent rule_code column

-- ============================================================================
-- VALIDATE REQUIRED CATEGORIES EXIST
-- ============================================================================

DO $$
DECLARE
  v_tenant_id text := 'SYSTEM';
  v_missing_categories text[] := ARRAY[]::text[];
  v_cat text;
BEGIN
  FOR v_cat IN 
    SELECT unnest(ARRAY[
      'DEPLOYMENT_GOVERNANCE', 'CSP_GOVERNANCE', 'NAVIGATION_GOVERNANCE',
      'UI_GOVERNANCE', 'MEMORY_GOVERNANCE', 'RULE_ENGINE_GOVERNANCE',
      'VALIDATOR_GOVERNANCE', 'API_GOVERNANCE', 'SECURITY_GOVERNANCE'
    ])
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM governance_categories 
      WHERE tenant_id = v_tenant_id AND name = v_cat
    ) THEN
      v_missing_categories := array_append(v_missing_categories, v_cat);
    END IF;
  END LOOP;

  IF array_length(v_missing_categories, 1) > 0 THEN
    RAISE EXCEPTION 'Missing required categories: %. Run migration 0102 first.', 
      array_to_string(v_missing_categories, ', ');
  END IF;

  RAISE NOTICE 'All required governance categories validated';
END $$;

-- ============================================================================
-- HELPER FUNCTION: INSERT RULE IF NOT EXISTS
-- ============================================================================

CREATE OR REPLACE FUNCTION insert_governance_rule(
  p_tenant_id text,
  p_category_name text,
  p_rule_code text,
  p_name text,
  p_description text,
  p_logic jsonb
)
RETURNS void AS $$
DECLARE
  v_category_id uuid;
BEGIN
  -- Get category ID
  SELECT id INTO v_category_id
  FROM governance_categories
  WHERE tenant_id = p_tenant_id AND name = p_category_name;

  IF v_category_id IS NULL THEN
    RAISE EXCEPTION 'Category % not found', p_category_name;
  END IF;

  -- Insert rule if it doesn't exist (check by logic->>'rule_code')
  IF NOT EXISTS (
    SELECT 1 FROM governance_rules
    WHERE tenant_id = p_tenant_id AND logic->>'rule_code' = p_rule_code
  ) THEN
    INSERT INTO governance_rules (tenant_id, category_id, name, description, logic, is_active)
    VALUES (p_tenant_id, v_category_id, p_name, p_description, p_logic, TRUE);
    RAISE NOTICE 'Inserted rule: %', p_rule_code;
  ELSE
    -- Update existing rule
    UPDATE governance_rules
    SET logic = p_logic,
        description = p_description,
        name = p_name,
        category_id = v_category_id
    WHERE tenant_id = p_tenant_id AND logic->>'rule_code' = p_rule_code;
    RAISE NOTICE 'Updated rule: %', p_rule_code;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- INSERT GOVERNANCE RULES LIBRARY
-- ============================================================================

DO $$
DECLARE
  v_tenant_id text := 'SYSTEM';
BEGIN
  -- DEPLOYMENT_GOVERNANCE RULES (4)
  PERFORM insert_governance_rule(v_tenant_id, 'DEPLOYMENT_GOVERNANCE', 'DEP-001', 'Canonical Deployment Script Only',
    'All gateway deployments MUST use ./scripts/deploy/deploy-service.sh gateway services/gateway. No custom deploy commands allowed.',
    jsonb_build_object('rule_code', 'DEP-001', 'name', 'Canonical Deployment Script Only', 'category_key', 'DEPLOYMENT_GOVERNANCE', 
      'governance_area', 'deployment', 'enforcement', 'mandatory', 'severity', 3, 'version', '1.0', 'source', 'vitana-governance-v1'));

  PERFORM insert_governance_rule(v_tenant_id, 'DEPLOYMENT_GOVERNANCE', 'DEP-002', 'Canonical Gateway Service Name',
    'All production & dev automation must deploy to service name "gateway" only.',
    jsonb_build_object('rule_code', 'DEP-002', 'name', 'Canonical Gateway Service Name', 'category_key', 'DEPLOYMENT_GOVERNANCE',
      'governance_area', 'deployment', 'enforcement', 'mandatory', 'severity', 3, 'version', '1.0', 'source', 'vitana-governance-v1'));

  PERFORM insert_governance_rule(v_tenant_id, 'DEPLOYMENT_GOVERNANCE', 'DEP-003', 'Build Validation Before Deploy',
    'npm run build (or equivalent) MUST succeed before deployment; deployment forbidden on failing build.',
    jsonb_build_object('rule_code', 'DEP-003', 'name', 'Build Validation Before Deploy', 'category_key', 'DEPLOYMENT_GOVERNANCE',
      'governance_area', 'deployment', 'enforcement', 'mandatory', 'severity', 3, 'version', '1.0', 'source', 'vitana-governance-v1'));

  PERFORM insert_governance_rule(v_tenant_id, 'DEPLOYMENT_GOVERNANCE', 'DEP-004', 'Post-Deploy Verification',
    'After deployment, verify: latestReadyRevisionName changed, API responds 200, CSP/Golden Board rules not violated.',
    jsonb_build_object('rule_code', 'DEP-004', 'name', 'Post-Deploy Verification', 'category_key', 'DEPLOYMENT_GOVERNANCE',
      'governance_area', 'deployment', 'enforcement', 'mandatory', 'severity', 2, 'version', '1.0', 'source', 'vitana-governance-v1'));

  -- CSP_GOVERNANCE RULES (3)
  PERFORM insert_governance_rule(v_tenant_id, 'CSP_GOVERNANCE', 'CSP-001', 'No Inline Scripts',
    'Disallow any <script> tag without src attribute. All JavaScript must be in external files.',
    jsonb_build_object('rule_code', 'CSP-001', 'name', 'No Inline Scripts', 'category_key', 'CSP_GOVERNANCE',
      'governance_area', 'security', 'enforcement', 'mandatory', 'severity', 3, 'version', '1.0', 'source', 'vitana-governance-v1'));

  PERFORM insert_governance_rule(v_tenant_id, 'CSP_GOVERNANCE', 'CSP-002', 'No External CDNs',
    'Disallow React/JS frameworks via CDN; must be bundled locally.',
    jsonb_build_object('rule_code', 'CSP-002', 'name', 'No External CDNs', 'category_key', 'CSP_GOVERNANCE',
      'governance_area', 'security', 'enforcement', 'mandatory', 'severity', 3, 'version', '1.0', 'source', 'vitana-governance-v1'));

  PERFORM insert_governance_rule(v_tenant_id, 'CSP_GOVERNANCE', 'CSP-003', 'CSP Violations = Hard Block',
    'Any CSP violation in build output MUST fail Validator and block deployment.',
    jsonb_build_object('rule_code', 'CSP-003', 'name', 'CSP Violations = Hard Block', 'category_key', 'CSP_GOVERNANCE',
      'governance_area', 'security', 'enforcement', 'mandatory', 'severity', 3, 'version', '1.0', 'source', 'vitana-governance-v1'));

  -- NAVIGATION_GOVERNANCE RULES (3)
  PERFORM insert_governance_rule(v_tenant_id, 'NAVIGATION_GOVERNANCE', 'NAV-001', 'Sidebar Canon Rule',
    'Sidebar has fixed order: Home, Community, Discover, Inbox, Health, Wallet, Sharing, Memory, Settings, Start Stream, Profile Capsule.',
    jsonb_build_object('rule_code', 'NAV-001', 'name', 'Sidebar Canon Rule', 'category_key', 'NAVIGATION_GOVERNANCE',
      'governance_area', 'ui', 'enforcement', 'mandatory', 'severity', 2, 'version', '1.0', 'source', 'vitana-governance-v1'));

  PERFORM insert_governance_rule(v_tenant_id, 'NAVIGATION_GOVERNANCE', 'NAV-002', 'Dev/Admin Sidebar Canon',
    'Vitana Dev and Vitana Admin sidebars must preserve their defined module lists per blueprint.',
    jsonb_build_object('rule_code', 'NAV-002', 'name', 'Dev/Admin Sidebar Canon', 'category_key', 'NAVIGATION_GOVERNANCE',
      'governance_area', 'ui', 'enforcement', 'mandatory', 'severity', 2, 'version', '1.0', 'source', 'vitana-governance-v1'));

  PERFORM insert_governance_rule(v_tenant_id, 'NAVIGATION_GOVERNANCE', 'NAV-003', 'Start Stream Placement',
    'Start Stream lives ONLY in the sidebar utility zone and is NOT a broadcast/live-room control.',
    jsonb_build_object('rule_code', 'NAV-003', 'name', 'Start Stream Placement', 'category_key', 'NAVIGATION_GOVERNANCE',
      'governance_area', 'ui', 'enforcement', 'mandatory', 'severity', 2, 'version', '1.0', 'source', 'vitana-governance-v1'));

  -- UI_GOVERNANCE RULES (2)
  PERFORM insert_governance_rule(v_tenant_id, 'UI_GOVERNANCE', 'UI-001', 'Golden Command Hub Task Board',
    'Preserve .task-board, .task-column, .task-card selectors and 3-column layout (Scheduled, In Progress, Completed).',
    jsonb_build_object('rule_code', 'UI-001', 'name', 'Golden Command Hub Task Board', 'category_key', 'UI_GOVERNANCE',
      'governance_area', 'ui', 'enforcement', 'mandatory', 'severity', 2, 'version', '1.0', 'source', 'vitana-governance-v1'));

  PERFORM insert_governance_rule(v_tenant_id, 'UI_GOVERNANCE', 'UI-002', 'Fixed Layout Regions',
    'Global sidebar, top bar, and main content frame are immutable; only the inner content area may change.',
    jsonb_build_object('rule_code', 'UI-002', 'name', 'Fixed Layout Regions', 'category_key', 'UI_GOVERNANCE',
      'governance_area', 'ui', 'enforcement', 'mandatory', 'severity', 2, 'version', '1.0', 'source', 'vitana-governance-v1'));

  -- MEMORY_GOVERNANCE RULES (2)
  PERFORM insert_governance_rule(v_tenant_id, 'MEMORY_GOVERNANCE', 'MEM-001', 'Memory-First Execution',
    'Agents must check governance, OASIS, and task history before asking user for configuration or URLs.',
    jsonb_build_object('rule_code', 'MEM-001', 'name', 'Memory-First Execution', 'category_key', 'MEMORY_GOVERNANCE',
      'governance_area', 'agent_behavior', 'enforcement', 'recommended', 'severity', 1, 'version', '1.0', 'source', 'vitana-governance-v1'));

  PERFORM insert_governance_rule(v_tenant_id, 'MEMORY_GOVERNANCE', 'MEM-002', 'No Duplicate Questions',
    'Agents must avoid asking for data already present in OASIS or governance.',
    jsonb_build_object('rule_code', 'MEM-002', 'name', 'No Duplicate Questions', 'category_key', 'MEMORY_GOVERNANCE',
      'governance_area', 'agent_behavior', 'enforcement', 'recommended', 'severity', 1, 'version', '1.0', 'source', 'vitana-governance-v1'));

  -- RULE_ENGINE_GOVERNANCE RULES (2)
  PERFORM insert_governance_rule(v_tenant_id, 'RULE_ENGINE_GOVERNANCE', 'RUL-001', 'Deterministic Evaluation',
    'Rule engine must be deterministic; same input → same output.',
    jsonb_build_object('rule_code', 'RUL-001', 'name', 'Deterministic Evaluation', 'category_key', 'RULE_ENGINE_GOVERNANCE',
      'governance_area', 'rule_engine', 'enforcement', 'mandatory', 'severity', 3, 'version', '1.0', 'source', 'vitana-governance-v1'));

  PERFORM insert_governance_rule(v_tenant_id, 'RULE_ENGINE_GOVERNANCE', 'RUL-002', 'Pre-Execution Check',
    'All critical actions (deployments, schema changes, CSP changes, navigation changes) MUST pass rule-engine checks before execution.',
    jsonb_build_object('rule_code', 'RUL-002', 'name', 'Pre-Execution Check', 'category_key', 'RULE_ENGINE_GOVERNANCE',
      'governance_area', 'rule_engine', 'enforcement', 'mandatory', 'severity', 3, 'version', '1.0', 'source', 'vitana-governance-v1'));

  -- VALIDATOR_GOVERNANCE RULES (3)
  PERFORM insert_governance_rule(v_tenant_id, 'VALIDATOR_GOVERNANCE', 'VAL-001', 'Validator Non-Creative',
    'Validator is forbidden from generating new code or architecture; it only approves or rejects.',
    jsonb_build_object('rule_code', 'VAL-001', 'name', 'Validator Non-Creative', 'category_key', 'VALIDATOR_GOVERNANCE',
      'governance_area', 'validator', 'enforcement', 'mandatory', 'severity', 3, 'version', '1.0', 'source', 'vitana-governance-v1'));

  PERFORM insert_governance_rule(v_tenant_id, 'VALIDATOR_GOVERNANCE', 'VAL-002', 'Governance-Backed Decisions',
    'Validator decisions MUST cite the relevant rules from governance_rules.',
    jsonb_build_object('rule_code', 'VAL-002', 'name', 'Governance-Backed Decisions', 'category_key', 'VALIDATOR_GOVERNANCE',
      'governance_area', 'validator', 'enforcement', 'mandatory', 'severity', 2, 'version', '1.0', 'source', 'vitana-governance-v1'));

  PERFORM insert_governance_rule(v_tenant_id, 'VALIDATOR_GOVERNANCE', 'VAL-003', 'Hard Stop on Uncertainty',
    'Any uncertainty or missing rule → Validator MUST block the action.',
    jsonb_build_object('rule_code', 'VAL-003', 'name', 'Hard Stop on Uncertainty', 'category_key', 'VALIDATOR_GOVERNANCE',
      'governance_area', 'validator', 'enforcement', 'mandatory', 'severity', 3, 'version', '1.0', 'source', 'vitana-governance-v1'));

  -- API_GOVERNANCE RULES (2)
  PERFORM insert_governance_rule(v_tenant_id, 'API_GOVERNANCE', 'API-001', 'Gateway Route Mount Rule',
    'Agents must inspect Express app mounts (app.use) and compute final paths correctly.',
    jsonb_build_object('rule_code', 'API-001', 'name', 'Gateway Route Mount Rule', 'category_key', 'API_GOVERNANCE',
      'governance_area', 'api', 'enforcement', 'mandatory', 'severity', 2, 'version', '1.0', 'source', 'vitana-governance-v1'));

  PERFORM insert_governance_rule(v_tenant_id, 'API_GOVERNANCE', 'API-002', 'OASIS Ingestion Integrity',
    'All new APIs impacting tasks/events MUST write to OASIS via the ingestion API.',
    jsonb_build_object('rule_code', 'API-002', 'name', 'OASIS Ingestion Integrity', 'category_key', 'API_GOVERNANCE',
      'governance_area', 'api', 'enforcement', 'mandatory', 'severity', 2, 'version', '1.0', 'source', 'vitana-governance-v1'));

  -- SECURITY_GOVERNANCE RULES (2)
  PERFORM insert_governance_rule(v_tenant_id, 'SECURITY_GOVERNANCE', 'SEC-001', 'No Hardcoded Secrets',
    'All secrets must come from environment or secret manager, never hardcoded.',
    jsonb_build_object('rule_code', 'SEC-001', 'name', 'No Hardcoded Secrets', 'category_key', 'SECURITY_GOVERNANCE',
      'governance_area', 'security', 'enforcement', 'mandatory', 'severity', 3, 'version', '1.0', 'source', 'vitana-governance-v1'));

  PERFORM insert_governance_rule(v_tenant_id, 'SECURITY_GOVERNANCE', 'GOV-SELF-001', 'Governance Violation Penalty',
    'If Gateway URL, CSP, Golden Board, or Sidebar Canon rules violated: log violation, trigger escalation, block deployments.',
    jsonb_build_object('rule_code', 'GOV-SELF-001', 'name', 'Governance Violation Penalty', 'category_key', 'SECURITY_GOVERNANCE',
      'governance_area', 'governance_enforcement', 'enforcement', 'mandatory', 'severity', 3, 'version', '1.0', 'source', 'vitana-governance-v1'));

  RAISE NOTICE 'Vitana Governance Rules Library seeded successfully (22 rules)';
END $$;

-- ============================================================================
-- CLEANUP HELPER FUNCTION
-- ============================================================================

DROP FUNCTION IF EXISTS insert_governance_rule(text, text, text, text, text, jsonb);

-- ============================================================================
-- VERIFY ALL RULES INSERTED
-- ============================================================================

DO $$
DECLARE
  v_total_rules integer;
BEGIN
  SELECT COUNT(*) INTO v_total_rules
  FROM governance_rules
  WHERE tenant_id = 'SYSTEM';

  RAISE NOTICE '========================================';
  RAISE NOTICE 'GOVERNANCE RULES LIBRARY COMPLETE';
  RAISE NOTICE 'Total SYSTEM rules: %', v_total_rules;
  RAISE NOTICE '========================================';
END $$;
