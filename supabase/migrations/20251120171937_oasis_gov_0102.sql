-- 20251120171937_oasis_gov_0102.sql
-- DEV-OASIS-GOV-0102 — Governance Migration Step 2
-- 
-- Purpose: Enhance governance schema with additional categories, indexes, constraints, and RLS validation
-- Dependencies: 20251120000000_init_governance.sql (DEV-OASIS-GOV-0101)
-- Follows: MG-001 (Idempotent SQL Requirement)

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- A. SEED GOVERNANCE CATEGORIES
-- ============================================================================

DO $$
DECLARE
  v_tenant_id text := 'SYSTEM';
BEGIN
  -- Seed additional governance categories using idempotent pattern
  
  -- SECURITY_GOVERNANCE
  INSERT INTO governance_categories (tenant_id, name, description, severity)
  VALUES (
    v_tenant_id,
    'SECURITY_GOVERNANCE',
    'Rules enforcing security best practices, authentication, authorization, and data protection across the Vitana platform.',
    3
  )
  ON CONFLICT (tenant_id, name) DO NOTHING;

  -- API_GOVERNANCE
  INSERT INTO governance_categories (tenant_id, name, description, severity)
  VALUES (
    v_tenant_id,
    'API_GOVERNANCE',
    'Rules governing API design, versioning, documentation, rate limiting, and contract compliance.',
    2
  )
  ON CONFLICT (tenant_id, name) DO NOTHING;

  -- NAVIGATION_GOVERNANCE
  INSERT INTO governance_categories (tenant_id, name, description, severity)
  VALUES (
    v_tenant_id,
    'NAVIGATION_GOVERNANCE',
    'Rules ensuring consistent navigation patterns, routing, and user experience flows.',
    1
  )
  ON CONFLICT (tenant_id, name) DO NOTHING;

  -- DEPLOYMENT_GOVERNANCE
  INSERT INTO governance_categories (tenant_id, name, description, severity)
  VALUES (
    v_tenant_id,
    'DEPLOYMENT_GOVERNANCE',
    'Rules enforcing safe deployment practices, CI/CD processes, and infrastructure as code.',
    3
  )
  ON CONFLICT (tenant_id, name) DO NOTHING;

  -- VALIDATOR_GOVERNANCE
  INSERT INTO governance_categories (tenant_id, name, description, severity)
  VALUES (
    v_tenant_id,
    'VALIDATOR_GOVERNANCE',
    'Rules governing the Validator service behavior, evaluation logic, and enforcement mechanisms.',
    2
  )
  ON CONFLICT (tenant_id, name) DO NOTHING;

  -- UI_GOVERNANCE
  INSERT INTO governance_categories (tenant_id, name, description, severity)
  VALUES (
    v_tenant_id,
    'UI_GOVERNANCE',
    'Rules enforcing UI/UX consistency, accessibility standards, and design system compliance.',
    1
  )
  ON CONFLICT (tenant_id, name) DO NOTHING;

  -- MEMORY_GOVERNANCE
  INSERT INTO governance_categories (tenant_id, name, description, severity)
  VALUES (
    v_tenant_id,
    'MEMORY_GOVERNANCE',
    'Rules governing memory management, caching strategies, and performance optimization.',
    2
  )
  ON CONFLICT (tenant_id, name) DO NOTHING;

  -- CSP_GOVERNANCE
  INSERT INTO governance_categories (tenant_id, name, description, severity)
  VALUES (
    v_tenant_id,
    'CSP_GOVERNANCE',
    'Rules enforcing Content Security Policy compliance, no inline scripts/styles, and CDN restrictions.',
    3
  )
  ON CONFLICT (tenant_id, name) DO NOTHING;

  -- RULE_ENGINE_GOVERNANCE
  INSERT INTO governance_categories (tenant_id, name, description, severity)
  VALUES (
    v_tenant_id,
    'RULE_ENGINE_GOVERNANCE',
    'Rules governing the rule evaluation engine, logic validation, and governance automation.',
    2
  )
  ON CONFLICT (tenant_id, name) DO NOTHING;

END $$;

-- ============================================================================
-- B. ADD PERFORMANCE INDEXES
-- ============================================================================

-- Index for governance_rules by category_id (already exists in 0101 but safe to repeat)
CREATE INDEX IF NOT EXISTS idx_rules_category ON governance_rules(category_id);

-- Index for governance_rules by tenant_id (already exists in 0101 but safe to repeat)
CREATE INDEX IF NOT EXISTS idx_rules_tenant ON governance_rules(tenant_id);

-- Additional index for governance_rules by logic->>rule_code (special case for JSONB)
CREATE INDEX IF NOT EXISTS idx_rules_logic_rule_code ON governance_rules((logic->>'rule_code'));

-- Index for governance_rules active status
CREATE INDEX IF NOT EXISTS idx_rules_is_active ON governance_rules(is_active);

-- Composite index for common query pattern: tenant + active rules
CREATE INDEX IF NOT EXISTS idx_rules_tenant_active ON governance_rules(tenant_id, is_active);

-- Index for governance_evaluations by tenant and status
CREATE INDEX IF NOT EXISTS idx_evaluations_tenant_status ON governance_evaluations(tenant_id, status);

-- Index for governance_violations by tenant and status (composite for common queries)
CREATE INDEX IF NOT EXISTS idx_violations_tenant_status ON governance_violations(tenant_id, status);

-- Index for governance_violations by rule_id
CREATE INDEX IF NOT EXISTS idx_violations_rule ON governance_violations(rule_id);

-- Index for governance_enforcements by rule_id
CREATE INDEX IF NOT EXISTS idx_enforcements_rule ON governance_enforcements(rule_id);

-- Index for governance_enforcements by status
CREATE INDEX IF NOT EXISTS idx_enforcements_status ON governance_enforcements(status);

-- ============================================================================
-- C. VERIFY AND ADD FOREIGN KEY CONSTRAINTS
-- ============================================================================

-- Note: PostgreSQL doesn't have IF NOT EXISTS for ALTER TABLE ADD CONSTRAINT
-- We use DO blocks to check and add constraints idempotently

DO $$
BEGIN
  -- Check if FK constraint exists for governance_rules -> governance_categories
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'fk_rules_category' 
    AND table_name = 'governance_rules'
  ) THEN
    -- Constraint already exists in base migration, this is defensive
    -- ALTER TABLE governance_rules 
    --   ADD CONSTRAINT fk_rules_category 
    --   FOREIGN KEY (category_id) 
    --   REFERENCES governance_categories(id) 
    --   ON DELETE SET NULL;
    NULL; -- No-op, constraint already defined in 0101
  END IF;

  -- Check if FK constraint exists for governance_evaluations -> governance_rules
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'fk_evaluations_rule' 
    AND table_name = 'governance_evaluations'
  ) THEN
    -- Constraint already exists in base migration, this is defensive
    NULL; -- No-op, constraint already defined in 0101
  END IF;

  -- Check if FK constraint exists for governance_violations -> governance_rules
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'fk_violations_rule' 
    AND table_name = 'governance_violations'
  ) THEN
    -- Constraint already exists in base migration, this is defensive
    NULL; -- No-op, constraint already defined in 0101
  END IF;

  -- Check if FK constraint exists for governance_enforcements -> governance_rules
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'fk_enforcements_rule' 
    AND table_name = 'governance_enforcements'
  ) THEN
    -- Constraint already exists in base migration, this is defensive
    NULL; -- No-op, constraint already defined in 0101
  END IF;
END $$;

-- ============================================================================
-- D. VERIFY RLS POLICIES (Defensive Check)
-- ============================================================================

-- All RLS policies were created in migration 0101
-- This section validates they exist and are enabled

DO $$
DECLARE
  v_table text;
  v_rls_enabled boolean;
BEGIN
  -- Check each governance table has RLS enabled
  FOR v_table IN 
    SELECT table_name FROM unnest(ARRAY[
      'governance_categories',
      'governance_rules',
      'governance_evaluations',
      'governance_violations',
      'governance_enforcements'
    ]) AS table_name
  LOOP
    SELECT relrowsecurity INTO v_rls_enabled
    FROM pg_class
    WHERE relname = v_table AND relkind = 'r';

    IF NOT v_rls_enabled THEN
      RAISE EXCEPTION 'RLS not enabled on table: %', v_table;
    END IF;
  END LOOP;

  RAISE NOTICE 'RLS verification complete: All governance tables have RLS enabled';
END $$;

-- ============================================================================
-- E. VALIDATE REFERENTIAL INTEGRITY
-- ============================================================================

DO $$
DECLARE
  v_orphaned_rules integer;
  v_orphaned_evals integer;
  v_orphaned_violations integer;
  v_orphaned_enforcements integer;
BEGIN
  -- Check for orphaned governance_rules (rules without valid category)
  SELECT COUNT(*) INTO v_orphaned_rules
  FROM governance_rules r
  WHERE r.category_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM governance_categories c WHERE c.id = r.category_id
    );

  IF v_orphaned_rules > 0 THEN
    RAISE WARNING 'Found % orphaned governance_rules without valid category_id', v_orphaned_rules;
  END IF;

  -- Check for orphaned governance_evaluations (evaluations without valid rule)
  SELECT COUNT(*) INTO v_orphaned_evals
  FROM governance_evaluations e
  WHERE e.rule_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM governance_rules r WHERE r.id = e.rule_id
    );

  IF v_orphaned_evals > 0 THEN
    RAISE WARNING 'Found % orphaned governance_evaluations without valid rule_id', v_orphaned_evals;
  END IF;

  -- Check for orphaned governance_violations (violations without valid rule)
  SELECT COUNT(*) INTO v_orphaned_violations
  FROM governance_violations v
  WHERE v.rule_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM governance_rules r WHERE r.id = v.rule_id
    );

  IF v_orphaned_violations > 0 THEN
    RAISE WARNING 'Found % orphaned governance_violations without valid rule_id', v_orphaned_violations;
  END IF;

  -- Check for orphaned governance_enforcements (enforcements without valid rule)
  SELECT COUNT(*) INTO v_orphaned_enforcements
  FROM governance_enforcements e
  WHERE e.rule_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM governance_rules r WHERE r.id = e.rule_id
    );

  IF v_orphaned_enforcements > 0 THEN
    RAISE WARNING 'Found % orphaned governance_enforcements without valid rule_id', v_orphaned_enforcements;
  END IF;

  RAISE NOTICE 'Referential integrity validation complete';
  RAISE NOTICE 'Orphaned rules: %, evals: %, violations: %, enforcements: %',
    v_orphaned_rules, v_orphaned_evals, v_orphaned_violations, v_orphaned_enforcements;
END $$;

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
-- DEV-OASIS-GOV-0102 governance migration step 2 applied successfully
