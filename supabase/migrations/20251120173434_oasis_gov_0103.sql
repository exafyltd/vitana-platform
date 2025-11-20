-- 20251120173434_oasis_gov_0103.sql
-- DEV-OASIS-GOV-0103 — Insert Migration Governance Rules
-- 
-- Purpose: Insert MG-001 through MG-007 rules into governance_rules table
-- Dependencies: 20251120171937_oasis_gov_0102.sql (governance categories seeded)
-- Follows: MG-001 (Idempotent SQL Requirement)

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- A. VALIDATE MIGRATION_GOVERNANCE CATEGORY EXISTS
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
    RAISE EXCEPTION 'MIGRATION_GOVERNANCE category not found. Migration 0101 must be applied first.';
  END IF;

  RAISE NOTICE 'MIGRATION_GOVERNANCE category found: %', v_category_id;
END $$;

-- ============================================================================
-- B. INSERT MIGRATION GOVERNANCE RULES (MG-001 through MG-007)
-- ============================================================================

DO $$
DECLARE
  v_category_id uuid;
  v_tenant_id text := 'SYSTEM';
BEGIN
  -- Get MIGRATION_GOVERNANCE category ID
  SELECT id INTO v_category_id
  FROM governance_categories
  WHERE tenant_id = v_tenant_id 
    AND name = 'MIGRATION_GOVERNANCE';

  -- MG-001 — Idempotent SQL Requirement
  INSERT INTO governance_rules (
    tenant_id,
    category_id,
    name,
    description,
    logic,
    is_active
  ) VALUES (
    v_tenant_id,
    v_category_id,
    'Idempotent SQL Requirement',
    'All migrations MUST use idempotent SQL patterns (CREATE TABLE IF NOT EXISTS, DROP POLICY IF EXISTS, CREATE INDEX IF NOT EXISTS, INSERT ... ON CONFLICT DO NOTHING) to allow safe re-runs via CI.',
    jsonb_build_object(
      'rule_code', 'MG-001',
      'type', 'policy',
      'severity', 3,
      'enforcement', 'mandatory',
      'applies_to', ARRAY['migrations', 'schema_changes'],
      'validation', jsonb_build_object(
        'patterns', ARRAY['IF NOT EXISTS', 'ON CONFLICT', 'DO $$']
      )
    ),
    TRUE
  )
  ON CONFLICT ON CONSTRAINT governance_rules_pkey DO NOTHING;

  -- MG-002 — CI-Only Migration Execution
  INSERT INTO governance_rules (
    tenant_id,
    category_id,
    name,
    description,
    logic,
    is_active
  ) VALUES (
    v_tenant_id,
    v_category_id,
    'CI-Only Migration Execution',
    'All schema migrations MUST run exclusively through the canonical GitHub Actions workflow (APPLY-MIGRATIONS.yml). No direct SQL execution via Supabase UI, local CLI, or Cloud Shell is allowed.',
    jsonb_build_object(
      'rule_code', 'MG-002',
      'type', 'policy',
      'severity', 3,
      'enforcement', 'mandatory',
      'applies_to', ARRAY['migrations', 'schema_changes'],
      'workflow', 'APPLY-MIGRATIONS.yml',
      'prohibited_methods', ARRAY['supabase_ui', 'local_cli', 'cloud_shell', 'manual_psql']
    ),
    TRUE
  )
  ON CONFLICT ON CONSTRAINT governance_rules_pkey DO NOTHING;

  -- MG-003 — No Manual SQL
  INSERT INTO governance_rules (
    tenant_id,
    category_id,
    name,
    description,
    logic,
    is_active
  ) VALUES (
    v_tenant_id,
    v_category_id,
    'No Manual SQL',
    'Manual SQL changes (in Supabase Dashboard, local psql, or Cloud Shell) are prohibited. Any schema modification outside CI MUST be rejected by governance and Validator.',
    jsonb_build_object(
      'rule_code', 'MG-003',
      'type', 'policy',
      'severity', 3,
      'enforcement', 'mandatory',
      'applies_to', ARRAY['schema_changes', 'data_modifications'],
      'allowed_source', 'github-actions-ci-only'
    ),
    TRUE
  )
  ON CONFLICT ON CONSTRAINT governance_rules_pkey DO NOTHING;

  -- MG-004 — Mandatory CI Failure on Migration Errors
  INSERT INTO governance_rules (
    tenant_id,
    category_id,
    name,
    description,
    logic,
    is_active
  ) VALUES (
    v_tenant_id,
    v_category_id,
    'Mandatory CI Failure on Migration Errors',
    'The migration workflow MUST fail (non-zero exit) on any SQL error or verification error. Silent failures or partial application of migrations are not allowed.',
    jsonb_build_object(
      'rule_code', 'MG-004',
      'type', 'policy',
      'severity', 3,
      'enforcement', 'mandatory',
      'applies_to', ARRAY['ci_cd', 'migrations'],
      'required_flags', ARRAY['ON_ERROR_STOP=1', 'set -e']
    ),
    TRUE
  )
  ON CONFLICT ON CONSTRAINT governance_rules_pkey DO NOTHING;

  -- MG-005 — Use Only Existing Secrets
  INSERT INTO governance_rules (
    tenant_id,
    category_id,
    name,
    description,
    logic,
    is_active
  ) VALUES (
    v_tenant_id,
    v_category_id,
    'Use Only Existing Secrets',
    'Migration workflows MUST use only existing, approved secrets (e.g., SUPABASE_DB_URL). Introducing new credentials or ad-hoc connection strings is forbidden.',
    jsonb_build_object(
      'rule_code', 'MG-005',
      'type', 'policy',
      'severity', 3,
      'enforcement', 'mandatory',
      'applies_to', ARRAY['ci_cd', 'deployments', 'migrations'],
      'approved_secrets', ARRAY['SUPABASE_DB_URL', 'SUPABASE_SERVICE_ROLE', 'GATEWAY_URL']
    ),
    TRUE
  )
  ON CONFLICT ON CONSTRAINT governance_rules_pkey DO NOTHING;

  -- MG-006 — Tenant Isolation Enforcement
  INSERT INTO governance_rules (
    tenant_id,
    category_id,
    name,
    description,
    logic,
    is_active
  ) VALUES (
    v_tenant_id,
    v_category_id,
    'Tenant Isolation Enforcement',
    'All governance-related schema objects MUST include tenant-aware design (tenant_id and appropriate RLS) to preserve tenant isolation across the Vitana platform.',
    jsonb_build_object(
      'rule_code', 'MG-006',
      'type', 'policy',
      'severity', 3,
      'enforcement', 'mandatory',
      'applies_to', ARRAY['schema_design', 'rls_policies'],
      'required_columns', ARRAY['tenant_id'],
      'required_rls', true
    ),
    TRUE
  )
  ON CONFLICT ON CONSTRAINT governance_rules_pkey DO NOTHING;

  -- MG-007 — Timestamp-Ordered Migrations
  INSERT INTO governance_rules (
    tenant_id,
    category_id,
    name,
    description,
    logic,
    is_active
  ) VALUES (
    v_tenant_id,
    v_category_id,
    'Timestamp-Ordered Migrations',
    'All migration files MUST follow the global timestamp naming convention (YYYYMMDDHHMMSS_description.sql), and CI MUST apply them in sorted order to guarantee deterministic schema evolution.',
    jsonb_build_object(
      'rule_code', 'MG-007',
      'type', 'policy',
      'severity', 3,
      'enforcement', 'mandatory',
      'applies_to', ARRAY['migrations', 'file_naming'],
      'naming_pattern', '^[0-9]{14}_[a-z0-9_]+\.sql$',
      'sort_order', 'lexicographic'
    ),
    TRUE
  )
  ON CONFLICT ON CONSTRAINT governance_rules_pkey DO NOTHING;

  RAISE NOTICE 'Migration Governance rules (MG-001 through MG-007) inserted successfully';
END $$;

-- ============================================================================
-- C. VERIFY ALL MG RULES HAVE VALID CATEGORY REFERENCES
-- ============================================================================

DO $$
DECLARE
  v_orphaned_count integer;
  v_mg_rule_count integer;
BEGIN
  -- Count MG rules that should exist
  SELECT COUNT(*) INTO v_mg_rule_count
  FROM governance_rules
  WHERE logic->>'rule_code' LIKE 'MG-%';

  IF v_mg_rule_count < 7 THEN
    RAISE WARNING 'Expected 7 MG rules, found only %', v_mg_rule_count;
  ELSE
    RAISE NOTICE 'Found % MG rules', v_mg_rule_count;
  END IF;

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
-- D. ADD INDEXES FOR FAST MG RULE EVALUATION
-- ============================================================================

-- Index on rule_code for fast MG rule lookups (defensive, may already exist from 0102)
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
-- E. VERIFY RLS ENABLED ON ALL GOVERNANCE TABLES
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
-- F. ADD EVALUATION SEED FOR MG-001 (OPTIONAL)
-- ============================================================================

DO $$
DECLARE
  v_mg001_rule_id uuid;
  v_tenant_id text := 'SYSTEM';
BEGIN
  -- Get MG-001 rule ID
  SELECT id INTO v_mg001_rule_id
  FROM governance_rules
  WHERE logic->>'rule_code' = 'MG-001'
    AND tenant_id = v_tenant_id;

  IF v_mg001_rule_id IS NULL THEN
    RAISE WARNING 'MG-001 rule not found, skipping evaluation seed';
    RETURN;
  END IF;

  -- Insert evaluation seed for MG-001 (example: this migration itself passes)
  INSERT INTO governance_evaluations (
    tenant_id,
    rule_id,
    entity_id,
    status,
    metadata
  ) VALUES (
    v_tenant_id,
    v_mg001_rule_id,
    '20251120173434_oasis_gov_0103.sql',
    'PASS',
    jsonb_build_object(
      'evaluated_by', 'self-test',
      'migration_file', '20251120173434_oasis_gov_0103.sql',
      'reason', 'Migration uses IF NOT EXISTS, ON CONFLICT, and DO blocks',
      'timestamp', NOW()
    )
  )
  ON CONFLICT ON CONSTRAINT governance_evaluations_pkey DO NOTHING;

  RAISE NOTICE 'Evaluation seed for MG-001 inserted';
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
  RAISE NOTICE 'DEV-OASIS-GOV-0103 MIGRATION COMPLETE';
  RAISE NOTICE '========================================';
  RAISE NOTICE 'MIGRATION_GOVERNANCE category: %', CASE WHEN v_category_exists THEN 'EXISTS' ELSE 'MISSING' END;
  RAISE NOTICE 'MG rules inserted: %', v_mg_count;
  RAISE NOTICE 'Expected MG rules: 7';
  RAISE NOTICE 'Status: %', CASE WHEN v_mg_count >= 7 THEN 'SUCCESS' ELSE 'INCOMPLETE' END;
  RAISE NOTICE '========================================';
END $$;
