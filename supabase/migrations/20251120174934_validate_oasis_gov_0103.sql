-- 20251120174934_validate_oasis_gov_0103.sql
-- DEV-OASIS-GOV-0103 — Validate Migration Governance Rules
-- 
-- Purpose: Validate MG-001 through MG-007 rules exist in governance schema
-- Note: MG rules are created by migration 20251120000001_add_migration_governance_rules.sql
--       This migration validates they were applied correctly
-- Follows: MG-001 (Idempotent SQL Requirement)

-- ============================================================================
-- VALIDATE MIGRATION_GOVERNANCE CATEGORY EXISTS
-- ============================================================================

DO $$
DECLARE
  v_category_id uuid;
  v_tenant_id text := 'SYSTEM';
BEGIN
  -- Check if MIGRATION_GOVERNANCE category exists
  SELECT id INTO v_category_id
  FROM governance_categories
  WHERE tenant_id = v_tenant_id 
    AND name = 'MIGRATION_GOVERNANCE';

  IF v_category_id IS NULL THEN
    RAISE EXCEPTION 'MIGRATION_GOVERNANCE category not found. Migration 20251120000001 must be applied.';
  END IF;

  RAISE NOTICE 'MIGRATION_GOVERNANCE category found: %', v_category_id;
END $$;

-- ============================================================================
-- VALIDATE ALL MG RULES EXIST (MG-001 through MG-007)
-- ============================================================================

DO $$
DECLARE
  v_tenant_id text := 'SYSTEM';
  v_missing_rules text[] := ARRAY[]::text[];
  v_rule_count integer;
  v_rule_code text;
BEGIN
  -- Check each MG rule individually
  FOR v_rule_code IN 
    SELECT unnest(ARRAY['MG-001', 'MG-002', 'MG-003', 'MG-004', 'MG-005', 'MG-006', 'MG-007'])
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM governance_rules 
      WHERE tenant_id = v_tenant_id 
        AND logic->>'rule_code' = v_rule_code
    ) THEN
      v_missing_rules := array_append(v_missing_rules, v_rule_code);
      RAISE WARNING 'Missing MG rule: %', v_rule_code;
    ELSE
      RAISE NOTICE 'Found MG rule: %', v_rule_code;
    END IF;
  END LOOP;

  -- Total count check
  SELECT COUNT(*) INTO v_rule_count
  FROM governance_rules
  WHERE tenant_id = v_tenant_id
    AND logic->>'rule_code' LIKE 'MG-%';
  
  RAISE NOTICE 'Total MG rules found: %', v_rule_count;

  IF array_length(v_missing_rules, 1) > 0 THEN
    RAISE EXCEPTION 'Missing MG rules: %. Migration 20251120000001 may not have run correctly.', 
      array_to_string(v_missing_rules, ', ');
  END IF;

  RAISE NOTICE 'All 7 MG rules validated successfully';
END $$;

-- ============================================================================
-- VERIFY ALL MG RULES HAVE VALID CATEGORY REFERENCES
-- ============================================================================

DO $$
DECLARE
  v_orphaned_count integer;
BEGIN
  -- Check for orphaned MG rules (rules without valid category)
  SELECT COUNT(*) INTO v_orphaned_count
  FROM governance_rules r
  WHERE r.logic->>'rule_code' LIKE 'MG-%'
    AND r.category_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM governance_categories c 
      WHERE c.id = r.category_id
    );

  IF v_orphaned_count > 0 THEN
    RAISE EXCEPTION 'Found % orphaned MG rules without valid category', v_orphaned_count;
  END IF;

  RAISE NOTICE 'All MG rules have valid category references';
END $$;

-- ============================================================================
-- ADD ADDITIONAL INDEXES FOR FAST MG RULE EVALUATION  
-- ============================================================================

-- Index on rule_code for fast MG rule lookups (may already exist from 0102)
CREATE INDEX IF NOT EXISTS idx_gov_rules_rule_code 
  ON governance_rules((logic->>'rule_code'));

-- Composite index for category + active status (query optimization)
CREATE INDEX IF NOT EXISTS idx_gov_rules_category_active 
  ON governance_rules(category_id, is_active);

-- Index for MG rules specifically (partial index for performance)
CREATE INDEX IF NOT EXISTS idx_gov_rules_mg_only 
  ON governance_rules(tenant_id, is_active)
  WHERE logic->>'rule_code' LIKE 'MG-%';

-- ============================================================================
-- VERIFY RLS ENABLED ON ALL GOVERNANCE TABLES
-- ============================================================================

DO $$
DECLARE
  v_table text;
  v_rls_enabled boolean;
BEGIN
  -- Check each governance table has RLS enabled
  FOR v_table IN 
    SELECT unnest(ARRAY[
      'governance_categories',
      'governance_rules',
      'governance_evaluations',
      'governance_violations',
      'governance_enforcements',
      'governance_proposals'
    ])
  LOOP
    SELECT relrowsecurity INTO v_rls_enabled
    FROM pg_class
    WHERE relname = v_table AND relkind = 'r';

    IF v_rls_enabled IS NULL THEN
      RAISE WARNING 'Table % does not exist', v_table;
    ELSIF NOT v_rls_enabled THEN
      RAISE EXCEPTION 'RLS not enabled on table: %', v_table;
    ELSE
      RAISE NOTICE 'RLS verified on table: %', v_table;
    END IF;
  END LOOP;

  RAISE NOTICE 'RLS verification complete: All governance tables have RLS enabled';
END $$;

-- ============================================================================
-- FINAL VALIDATION SUMMARY
-- ============================================================================

DO $$
DECLARE
  v_mg_count integer;
  v_category_exists boolean;
BEGIN
  -- Final count of MG rules
  SELECT COUNT(*) INTO v_mg_count
  FROM governance_rules
  WHERE logic->>'rule_code' LIKE 'MG-%';

  -- Verify MIGRATION_GOVERNANCE category
  SELECT EXISTS(
    SELECT 1 FROM governance_categories 
    WHERE name = 'MIGRATION_GOVERNANCE'
  ) INTO v_category_exists;

  RAISE NOTICE '========================================';
  RAISE NOTICE 'DEV-OASIS-GOV-0103 VALIDATION COMPLETE';
  RAISE NOTICE '========================================';
  RAISE NOTICE 'MIGRATION_GOVERNANCE category: %', CASE WHEN v_category_exists THEN 'EXISTS' ELSE 'MISSING' END;
  RAISE NOTICE 'MG rules validated: %', v_mg_count;
  RAISE NOTICE 'Expected MG rules: 7';
  RAISE NOTICE 'Status: %', CASE WHEN v_mg_count >= 7 THEN 'SUCCESS ✓' ELSE 'INCOMPLETE ✗' END;
  RAISE NOTICE '========================================';
END $$;
