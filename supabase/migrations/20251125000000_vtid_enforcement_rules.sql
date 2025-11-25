-- 20251125000000_vtid_enforcement_rules.sql
-- DEV-OASIS-0206 — VTID Enforcement Governance Rules
--
-- Purpose: Add three mandatory governance rules for VTID enforcement:
--   1. VTID_AUTOMATIC_CREATION_REQUIRED
--   2. VTID_LEDGER_SINGLE_SOURCE_OF_TRUTH
--   3. VTID_CONTEXT_REUSE_REQUIRED
--
-- Dependencies: governance_categories, governance_rules tables must exist
-- Follows: MG-001 (Idempotent SQL Requirement)

-- ============================================================================
-- ENSURE VTID_GOVERNANCE CATEGORY EXISTS
-- ============================================================================

DO $$
DECLARE
  v_tenant_id text := 'SYSTEM';
  v_category_id uuid;
BEGIN
  -- Check if VTID_GOVERNANCE category exists
  SELECT id INTO v_category_id
  FROM governance_categories
  WHERE tenant_id = v_tenant_id AND name = 'VTID_GOVERNANCE';

  -- Create it if it doesn't exist
  IF v_category_id IS NULL THEN
    INSERT INTO governance_categories (tenant_id, name, description, severity)
    VALUES (
      v_tenant_id,
      'VTID_GOVERNANCE',
      'Rules governing VTID allocation, validation, and enforcement across all agents',
      3
    )
    RETURNING id INTO v_category_id;
    RAISE NOTICE 'Created VTID_GOVERNANCE category: %', v_category_id;
  ELSE
    RAISE NOTICE 'VTID_GOVERNANCE category already exists: %', v_category_id;
  END IF;
END $$;

-- ============================================================================
-- INSERT VTID ENFORCEMENT RULES
-- ============================================================================

DO $$
DECLARE
  v_tenant_id text := 'SYSTEM';
  v_category_id uuid;
BEGIN
  -- Get VTID_GOVERNANCE category ID
  SELECT id INTO v_category_id
  FROM governance_categories
  WHERE tenant_id = v_tenant_id AND name = 'VTID_GOVERNANCE';

  IF v_category_id IS NULL THEN
    RAISE EXCEPTION 'VTID_GOVERNANCE category not found';
  END IF;

  -- Rule 1: VTID_AUTOMATIC_CREATION_REQUIRED
  IF NOT EXISTS (
    SELECT 1 FROM governance_rules
    WHERE tenant_id = v_tenant_id AND logic->>'rule_code' = 'VTID-001'
  ) THEN
    INSERT INTO governance_rules (tenant_id, category_id, name, description, logic, is_active)
    VALUES (
      v_tenant_id,
      v_category_id,
      'VTID Automatic Creation Required',
      'All new tasks must obtain VTID via /api/v1/vtid/get-or-create endpoint. Manual VTID construction is forbidden. Agents must call this endpoint at the start of any task that requires tracking.',
      jsonb_build_object(
        'rule_code', 'VTID-001',
        'name', 'VTID Automatic Creation Required',
        'category_key', 'VTID_GOVERNANCE',
        'governance_area', 'vtid_management',
        'enforcement', 'mandatory',
        'severity', 3,
        'version', '1.0',
        'source', 'DEV-OASIS-0206',
        'endpoint', '/api/v1/vtid/get-or-create',
        'validation', jsonb_build_object(
          'format_regex', '^[A-Z]+-[A-Z0-9]+-\\d{4}(-\\d{4})?$',
          'valid_layers', ARRAY['DEV', 'ADM', 'GOVRN', 'OASIS']
        ),
        'relatedServices', ARRAY['gateway', 'validator-core']
      ),
      TRUE
    );
    RAISE NOTICE 'Inserted rule: VTID-001 (VTID Automatic Creation Required)';
  ELSE
    RAISE NOTICE 'Rule VTID-001 already exists';
  END IF;

  -- Rule 2: VTID_LEDGER_SINGLE_SOURCE_OF_TRUTH
  IF NOT EXISTS (
    SELECT 1 FROM governance_rules
    WHERE tenant_id = v_tenant_id AND logic->>'rule_code' = 'VTID-002'
  ) THEN
    INSERT INTO governance_rules (tenant_id, category_id, name, description, logic, is_active)
    VALUES (
      v_tenant_id,
      v_category_id,
      'VTID Ledger Single Source of Truth',
      'All VTIDs must come from the VTID ledger database. No manual increments, pattern guessing, or invented IDs are allowed. The ledger uses database sequences to ensure uniqueness.',
      jsonb_build_object(
        'rule_code', 'VTID-002',
        'name', 'VTID Ledger Single Source of Truth',
        'category_key', 'VTID_GOVERNANCE',
        'governance_area', 'vtid_management',
        'enforcement', 'mandatory',
        'severity', 3,
        'version', '1.0',
        'source', 'DEV-OASIS-0206',
        'validation', jsonb_build_object(
          'must_exist_in_ledger', true,
          'invented_detection', true
        ),
        'relatedServices', ARRAY['gateway', 'supabase']
      ),
      TRUE
    );
    RAISE NOTICE 'Inserted rule: VTID-002 (VTID Ledger Single Source of Truth)';
  ELSE
    RAISE NOTICE 'Rule VTID-002 already exists';
  END IF;

  -- Rule 3: VTID_CONTEXT_REUSE_REQUIRED
  IF NOT EXISTS (
    SELECT 1 FROM governance_rules
    WHERE tenant_id = v_tenant_id AND logic->>'rule_code' = 'VTID-003'
  ) THEN
    INSERT INTO governance_rules (tenant_id, category_id, name, description, logic, is_active)
    VALUES (
      v_tenant_id,
      v_category_id,
      'VTID Context Reuse Required',
      'If a task already has a VTID in OASIS or Command Hub context, agents MUST reuse it rather than creating a new one. Creating duplicate VTIDs for the same work item is forbidden.',
      jsonb_build_object(
        'rule_code', 'VTID-003',
        'name', 'VTID Context Reuse Required',
        'category_key', 'VTID_GOVERNANCE',
        'governance_area', 'vtid_management',
        'enforcement', 'mandatory',
        'severity', 2,
        'version', '1.0',
        'source', 'DEV-OASIS-0206',
        'validation', jsonb_build_object(
          'check_oasis_context', true,
          'check_commandhub_context', true
        ),
        'relatedServices', ARRAY['gateway', 'oasis', 'commandhub']
      ),
      TRUE
    );
    RAISE NOTICE 'Inserted rule: VTID-003 (VTID Context Reuse Required)';
  ELSE
    RAISE NOTICE 'Rule VTID-003 already exists';
  END IF;

  RAISE NOTICE '========================================';
  RAISE NOTICE 'VTID ENFORCEMENT RULES COMPLETE';
  RAISE NOTICE '========================================';
END $$;

-- ============================================================================
-- VERIFY RULES INSERTED
-- ============================================================================

DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM governance_rules
  WHERE tenant_id = 'SYSTEM' AND logic->>'rule_code' LIKE 'VTID-%';

  RAISE NOTICE 'Total VTID governance rules: %', v_count;
END $$;
