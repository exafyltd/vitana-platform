-- 20251120000001_add_migration_governance_rules.sql
-- DEV-OASIS-GOV-0103 – Autonomous Migration Governance Rule
--
-- Adapted for Schema:
--   governance_categories(id, tenant_id, name, description, ...)
--   governance_rules(id, tenant_id, category_id, name, description, logic, is_active, ...)
--
-- Changes:
--   - Uses tenant_id = 'SYSTEM' for all entries (mandatory column)
--   - Maps 'category_code' to 'name' in governance_categories
--   - Maps 'rule_code' to 'logic->>rule_code' in governance_rules (and stores it in logic jsonb)
--   - Uses DO block to manage variables and dependencies

DO $$
DECLARE
  v_tenant_id text := 'SYSTEM';
  v_category_id uuid;
BEGIN

  -- 1) Ensure MIGRATION_GOVERNANCE category exists
  INSERT INTO governance_categories (tenant_id, name, description)
  VALUES (
    v_tenant_id,
    'MIGRATION_GOVERNANCE',
    'Rules enforcing autonomous, idempotent, CI-only schema migrations across the entire Vitana platform.'
  )
  ON CONFLICT (tenant_id, name) DO UPDATE 
  SET description = EXCLUDED.description
  RETURNING id INTO v_category_id;

  -- Fallback if no update happened (shouldn't happen with DO UPDATE, but safe practice)
  IF v_category_id IS NULL THEN
    SELECT id INTO v_category_id 
    FROM governance_categories 
    WHERE tenant_id = v_tenant_id AND name = 'MIGRATION_GOVERNANCE';
  END IF;

  -- 2) Ensure MG-001 … MG-007 rules exist

  -- MG-001 — Idempotent SQL Requirement
  IF NOT EXISTS (SELECT 1 FROM governance_rules WHERE tenant_id = v_tenant_id AND logic->>'rule_code' = 'MG-001') THEN
    INSERT INTO governance_rules (tenant_id, category_id, name, description, is_active, logic)
    VALUES (
      v_tenant_id,
      v_category_id,
      'Idempotent SQL Requirement',
      'All migrations MUST use idempotent SQL patterns (CREATE TABLE IF NOT EXISTS, DROP POLICY IF EXISTS, CREATE INDEX IF NOT EXISTS, INSERT ... ON CONFLICT DO NOTHING) to allow safe re-runs via CI.',
      TRUE,
      '{"rule_code": "MG-001", "type": "policy"}'::jsonb
    );
  END IF;

  -- MG-002 — CI-Only Migration Execution
  IF NOT EXISTS (SELECT 1 FROM governance_rules WHERE tenant_id = v_tenant_id AND logic->>'rule_code' = 'MG-002') THEN
    INSERT INTO governance_rules (tenant_id, category_id, name, description, is_active, logic)
    VALUES (
      v_tenant_id,
      v_category_id,
      'CI-Only Migration Execution',
      'All schema migrations MUST run exclusively through the canonical GitHub Actions workflow (APPLY-MIGRATIONS.yml). No direct SQL execution via Supabase UI, local CLI, or Cloud Shell is allowed.',
      TRUE,
      '{"rule_code": "MG-002", "type": "policy"}'::jsonb
    );
  END IF;

  -- MG-003 — No Manual SQL
  IF NOT EXISTS (SELECT 1 FROM governance_rules WHERE tenant_id = v_tenant_id AND logic->>'rule_code' = 'MG-003') THEN
    INSERT INTO governance_rules (tenant_id, category_id, name, description, is_active, logic)
    VALUES (
      v_tenant_id,
      v_category_id,
      'No Manual SQL',
      'Manual SQL changes (in Supabase Dashboard, local psql, or Cloud Shell) are prohibited. Any schema modification outside CI MUST be rejected by governance and Validator.',
      TRUE,
      '{"rule_code": "MG-003", "type": "policy"}'::jsonb
    );
  END IF;

  -- MG-004 — Mandatory CI Failure on Migration Errors
  IF NOT EXISTS (SELECT 1 FROM governance_rules WHERE tenant_id = v_tenant_id AND logic->>'rule_code' = 'MG-004') THEN
    INSERT INTO governance_rules (tenant_id, category_id, name, description, is_active, logic)
    VALUES (
      v_tenant_id,
      v_category_id,
      'Mandatory CI Failure on Migration Errors',
      'The migration workflow MUST fail (non-zero exit) on any SQL error or verification error. Silent failures or partial application of migrations are not allowed.',
      TRUE,
      '{"rule_code": "MG-004", "type": "policy"}'::jsonb
    );
  END IF;

  -- MG-005 — Use Only Existing Secrets
  IF NOT EXISTS (SELECT 1 FROM governance_rules WHERE tenant_id = v_tenant_id AND logic->>'rule_code' = 'MG-005') THEN
    INSERT INTO governance_rules (tenant_id, category_id, name, description, is_active, logic)
    VALUES (
      v_tenant_id,
      v_category_id,
      'Use Only Existing Secrets',
      'Migration workflows MUST use only existing, approved secrets (e.g., SUPABASE_DB_URL). Introducing new credentials or ad-hoc connection strings is forbidden.',
      TRUE,
      '{"rule_code": "MG-005", "type": "policy"}'::jsonb
    );
  END IF;

  -- MG-006 — Tenant Isolation Enforcement
  IF NOT EXISTS (SELECT 1 FROM governance_rules WHERE tenant_id = v_tenant_id AND logic->>'rule_code' = 'MG-006') THEN
    INSERT INTO governance_rules (tenant_id, category_id, name, description, is_active, logic)
    VALUES (
      v_tenant_id,
      v_category_id,
      'Tenant Isolation Enforcement',
      'All governance-related schema objects MUST include tenant-aware design (tenant_id and appropriate RLS) to preserve tenant isolation across the Vitana platform.',
      TRUE,
      '{"rule_code": "MG-006", "type": "policy"}'::jsonb
    );
  END IF;

  -- MG-007 — Timestamp-Ordered Migrations
  IF NOT EXISTS (SELECT 1 FROM governance_rules WHERE tenant_id = v_tenant_id AND logic->>'rule_code' = 'MG-007') THEN
    INSERT INTO governance_rules (tenant_id, category_id, name, description, is_active, logic)
    VALUES (
      v_tenant_id,
      v_category_id,
      'Timestamp-Ordered Migrations',
      'All migration files MUST follow the global timestamp naming convention (YYYYMMDDHHMMSS_description.sql), and CI MUST apply them in sorted order to guarantee deterministic schema evolution.',
      TRUE,
      '{"rule_code": "MG-007", "type": "policy"}'::jsonb
    );
  END IF;

END $$;
