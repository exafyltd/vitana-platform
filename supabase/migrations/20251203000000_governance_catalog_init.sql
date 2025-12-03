-- ============================================================
-- GOVERNANCE CATALOG INITIALIZATION
-- VTID: VTID-0400
-- Purpose: Initialize governance catalog and seed rules from codebase
-- ============================================================

-- 1. Create governance_catalog table for versioned catalog metadata
CREATE TABLE IF NOT EXISTS governance_catalog (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    version TEXT NOT NULL,
    commit_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    rules_count INTEGER DEFAULT 0,
    categories_count INTEGER DEFAULT 0,
    metadata JSONB DEFAULT '{}'::jsonb,
    UNIQUE(version)
);

-- Enable RLS on governance_catalog
ALTER TABLE governance_catalog ENABLE ROW LEVEL SECURITY;

-- RLS Policies for governance_catalog
DROP POLICY IF EXISTS "Enable read access for auth users on catalog" ON governance_catalog;
CREATE POLICY "Enable read access for auth users on catalog" ON governance_catalog FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Enable write access for service role on catalog" ON governance_catalog;
CREATE POLICY "Enable write access for service role on catalog" ON governance_catalog FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 2. Create indexes for governance_catalog
CREATE INDEX IF NOT EXISTS idx_catalog_version ON governance_catalog(version);
CREATE INDEX IF NOT EXISTS idx_catalog_created_at ON governance_catalog(created_at DESC);

-- 3. Add level and catalog_id columns to governance_rules if not exist
DO $$
BEGIN
    -- Add level column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'governance_rules' AND column_name = 'level') THEN
        ALTER TABLE governance_rules ADD COLUMN level TEXT DEFAULT 'L2';
    END IF;

    -- Add rule_id column (GOV-XXX-NNN format) if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'governance_rules' AND column_name = 'rule_id') THEN
        ALTER TABLE governance_rules ADD COLUMN rule_id TEXT;
    END IF;

    -- Add enforcement column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'governance_rules' AND column_name = 'enforcement') THEN
        ALTER TABLE governance_rules ADD COLUMN enforcement TEXT[] DEFAULT '{}';
    END IF;

    -- Add sources column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'governance_rules' AND column_name = 'sources') THEN
        ALTER TABLE governance_rules ADD COLUMN sources TEXT[] DEFAULT '{}';
    END IF;

    -- Add vtids column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'governance_rules' AND column_name = 'vtids') THEN
        ALTER TABLE governance_rules ADD COLUMN vtids TEXT[] DEFAULT '{}';
    END IF;

    -- Add commit_hash column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'governance_rules' AND column_name = 'commit_hash') THEN
        ALTER TABLE governance_rules ADD COLUMN commit_hash TEXT;
    END IF;

    -- Add catalog_version column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'governance_rules' AND column_name = 'catalog_version') THEN
        ALTER TABLE governance_rules ADD COLUMN catalog_version TEXT DEFAULT '0.1';
    END IF;
END $$;

-- 4. Create unique index on rule_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_rules_rule_id ON governance_rules(rule_id) WHERE rule_id IS NOT NULL;

-- 5. Add category_code to governance_categories if not exists
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'governance_categories' AND column_name = 'code') THEN
        ALTER TABLE governance_categories ADD COLUMN code TEXT;
    END IF;
END $$;

-- Create unique index on category code
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_code ON governance_categories(tenant_id, code) WHERE code IS NOT NULL;

-- 6. Insert catalog version record
INSERT INTO governance_catalog (version, commit_hash, rules_count, categories_count, metadata)
VALUES (
    '0.1',
    '654c542667c45e741bc47cfc85e817ca4f5db9f8',
    35,
    6,
    '{"extracted_from": "codebase", "vtid": "VTID-0400", "extraction_date": "2025-12-03"}'::jsonb
)
ON CONFLICT (version) DO UPDATE SET
    commit_hash = EXCLUDED.commit_hash,
    rules_count = EXCLUDED.rules_count,
    categories_count = EXCLUDED.categories_count,
    metadata = EXCLUDED.metadata,
    updated_at = NOW();

-- 7. Insert/Update Categories
DO $$
DECLARE
    v_tenant_id text := 'SYSTEM';
BEGIN
    -- MIGRATION category
    INSERT INTO governance_categories (tenant_id, code, name, description, severity)
    VALUES (v_tenant_id, 'MIGRATION', 'Migration Governance', 'Rules enforcing autonomous, idempotent, CI-only schema migrations', 3)
    ON CONFLICT (tenant_id, name) DO UPDATE SET code = EXCLUDED.code, description = EXCLUDED.description;

    -- FRONTEND category
    INSERT INTO governance_categories (tenant_id, code, name, description, severity)
    VALUES (v_tenant_id, 'FRONTEND', 'Frontend Governance', 'Rules enforcing frontend structure, navigation, and security', 2)
    ON CONFLICT (tenant_id, name) DO UPDATE SET code = EXCLUDED.code, description = EXCLUDED.description;

    -- CICD category
    INSERT INTO governance_categories (tenant_id, code, name, description, severity)
    VALUES (v_tenant_id, 'CICD', 'CI/CD Governance', 'Rules enforcing CI/CD workflow standards and naming conventions', 2)
    ON CONFLICT (tenant_id, name) DO UPDATE SET code = EXCLUDED.code, description = EXCLUDED.description;

    -- DB category
    INSERT INTO governance_categories (tenant_id, code, name, description, severity)
    VALUES (v_tenant_id, 'DB', 'Database Governance', 'Rules enforcing database security, RLS, and tenant isolation', 1)
    ON CONFLICT (tenant_id, name) DO UPDATE SET code = EXCLUDED.code, description = EXCLUDED.description;

    -- AGENT category
    INSERT INTO governance_categories (tenant_id, code, name, description, severity)
    VALUES (v_tenant_id, 'AGENT', 'Agent Governance', 'Rules enforcing autonomous agent behavior and operational protocols', 4)
    ON CONFLICT (tenant_id, name) DO UPDATE SET code = EXCLUDED.code, description = EXCLUDED.description;

    -- API category
    INSERT INTO governance_categories (tenant_id, code, name, description, severity)
    VALUES (v_tenant_id, 'API', 'API Governance', 'Rules enforcing API standards, traceability, and health monitoring', 2)
    ON CONFLICT (tenant_id, name) DO UPDATE SET code = EXCLUDED.code, description = EXCLUDED.description;
END $$;

-- 8. Insert/Update Governance Rules from Catalog
DO $$
DECLARE
    v_tenant_id text := 'SYSTEM';
    v_migration_cat_id uuid;
    v_frontend_cat_id uuid;
    v_cicd_cat_id uuid;
    v_db_cat_id uuid;
    v_agent_cat_id uuid;
    v_api_cat_id uuid;
    v_commit_hash text := '654c542667c45e741bc47cfc85e817ca4f5db9f8';
BEGIN
    -- Get category IDs
    SELECT id INTO v_migration_cat_id FROM governance_categories WHERE tenant_id = v_tenant_id AND code = 'MIGRATION';
    SELECT id INTO v_frontend_cat_id FROM governance_categories WHERE tenant_id = v_tenant_id AND code = 'FRONTEND';
    SELECT id INTO v_cicd_cat_id FROM governance_categories WHERE tenant_id = v_tenant_id AND code = 'CICD';
    SELECT id INTO v_db_cat_id FROM governance_categories WHERE tenant_id = v_tenant_id AND code = 'DB';
    SELECT id INTO v_agent_cat_id FROM governance_categories WHERE tenant_id = v_tenant_id AND code = 'AGENT';
    SELECT id INTO v_api_cat_id FROM governance_categories WHERE tenant_id = v_tenant_id AND code = 'API';

    -- MIGRATION GOVERNANCE RULES (L3)
    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_migration_cat_id, 'GOV-MIGRATION-001', 'Idempotent SQL Requirement',
            'All migrations MUST use idempotent SQL patterns (CREATE TABLE IF NOT EXISTS, DROP POLICY IF EXISTS, CREATE INDEX IF NOT EXISTS, INSERT ... ON CONFLICT DO NOTHING) to allow safe re-runs via CI.',
            'L3', ARRAY['backend', 'CI', 'DB'],
            ARRAY['supabase/migrations/20251120000001_add_migration_governance_rules.sql', '.github/workflows/APPLY-MIGRATIONS.yml'],
            ARRAY['DEV-OASIS-GOV-0103'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-MIGRATION-001", "type": "policy"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_migration_cat_id, 'GOV-MIGRATION-002', 'CI-Only Migration Execution',
            'All schema migrations MUST run exclusively through the canonical GitHub Actions workflow (APPLY-MIGRATIONS.yml). No direct SQL execution via Supabase UI, local CLI, or Cloud Shell is allowed.',
            'L3', ARRAY['CI', 'DB'],
            ARRAY['supabase/migrations/20251120000001_add_migration_governance_rules.sql', '.github/workflows/APPLY-MIGRATIONS.yml'],
            ARRAY['DEV-OASIS-GOV-0102', 'DEV-OASIS-GOV-0103'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-MIGRATION-002", "type": "policy"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_migration_cat_id, 'GOV-MIGRATION-003', 'No Manual SQL',
            'Manual SQL changes (in Supabase Dashboard, local psql, or Cloud Shell) are prohibited. Any schema modification outside CI MUST be rejected by governance and Validator.',
            'L3', ARRAY['CI', 'DB', 'agents'],
            ARRAY['supabase/migrations/20251120000001_add_migration_governance_rules.sql'],
            ARRAY['DEV-OASIS-GOV-0103'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-MIGRATION-003", "type": "policy"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_migration_cat_id, 'GOV-MIGRATION-004', 'Mandatory CI Failure on Migration Errors',
            'The migration workflow MUST fail (non-zero exit) on any SQL error or verification error. Silent failures or partial application of migrations are not allowed.',
            'L3', ARRAY['CI'],
            ARRAY['supabase/migrations/20251120000001_add_migration_governance_rules.sql', '.github/workflows/APPLY-MIGRATIONS.yml'],
            ARRAY['DEV-OASIS-GOV-0103'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-MIGRATION-004", "type": "policy"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_migration_cat_id, 'GOV-MIGRATION-005', 'Use Only Existing Secrets',
            'Migration workflows MUST use only existing, approved secrets (e.g., SUPABASE_DB_URL). Introducing new credentials or ad-hoc connection strings is forbidden.',
            'L3', ARRAY['CI'],
            ARRAY['supabase/migrations/20251120000001_add_migration_governance_rules.sql', '.github/workflows/APPLY-MIGRATIONS.yml'],
            ARRAY['DEV-OASIS-GOV-0103'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-MIGRATION-005", "type": "policy"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_migration_cat_id, 'GOV-MIGRATION-006', 'Tenant Isolation Enforcement',
            'All governance-related schema objects MUST include tenant-aware design (tenant_id and appropriate RLS) to preserve tenant isolation across the Vitana platform.',
            'L3', ARRAY['backend', 'DB'],
            ARRAY['supabase/migrations/20251120000001_add_migration_governance_rules.sql', 'supabase/migrations/20251120000000_init_governance.sql'],
            ARRAY['DEV-OASIS-GOV-0103'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-MIGRATION-006", "type": "policy"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_migration_cat_id, 'GOV-MIGRATION-007', 'Timestamp-Ordered Migrations',
            'All migration files MUST follow the global timestamp naming convention (YYYYMMDDHHMMSS_description.sql), and CI MUST apply them in sorted order to guarantee deterministic schema evolution.',
            'L3', ARRAY['CI', 'DB'],
            ARRAY['supabase/migrations/20251120000001_add_migration_governance_rules.sql', '.github/workflows/APPLY-MIGRATIONS.yml'],
            ARRAY['DEV-OASIS-GOV-0103'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-MIGRATION-007", "type": "policy"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    -- FRONTEND GOVERNANCE RULES (L2-L3)
    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_frontend_cat_id, 'GOV-FRONTEND-001', 'Frontend Canonical Source',
            'Only one valid source tree for the Command Hub is allowed: services/gateway/src/frontend/command-hub. Forbidden paths include static/command-hub, public/command-hub, frontend/command-hub, and any variant casing. CI and Validator block violations.',
            'L3', ARRAY['frontend', 'CI'],
            ARRAY['services/validators/frontend-canonical-source.js', '.github/workflows/ENFORCE-FRONTEND-CANONICAL-SOURCE.yml', 'docs/governance/CEO-HANDOVER-REVISED.md'],
            ARRAY['DEV-CICDL-0205', 'GOV-FRONTEND-CANONICAL-SOURCE-0001'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-FRONTEND-001", "type": "structural"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_frontend_cat_id, 'GOV-FRONTEND-002', 'Navigation Canon',
            'The frontend navigation structure is fixed with exactly 17 modules and 87 screens in a canonical order. This structure MUST match the OASIS spec in specs/dev_screen_inventory_v1.json. Modifications require OASIS spec update first.',
            'L2', ARRAY['frontend', 'CI'],
            ARRAY['services/gateway/src/frontend/command-hub/navigation-config.js'],
            ARRAY['DEV-CICDL-0205'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-FRONTEND-002", "type": "structural", "modules": 17, "screens": 87}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_frontend_cat_id, 'GOV-FRONTEND-003', 'CSP Compliance',
            'All frontend routes MUST set Content-Security-Policy headers. No inline scripts or styles allowed. CSP: default-src ''self''; script-src ''self''; style-src ''self''; connect-src ''self''.',
            'L2', ARRAY['frontend', 'backend'],
            ARRAY['services/gateway/src/routes/command-hub.ts'],
            ARRAY['DEV-CICDL-0205'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-FRONTEND-003", "type": "security"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    -- CI/CD GOVERNANCE RULES (L2)
    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_cicd_cat_id, 'GOV-CICD-001', 'Workflow UPPERCASE Naming',
            'All GitHub Actions workflow files MUST use UPPERCASE names with hyphens (e.g., DEPLOY-GATEWAY.yml, RUN-TESTS.yml). Reusable workflows prefixed with underscore (_) are exempt.',
            'L2', ARRAY['CI'],
            ARRAY['.github/workflows/PHASE-2B-NAMING-ENFORCEMENT.yml'],
            ARRAY['DEV-CICDL-0033'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-CICD-001", "type": "naming"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_cicd_cat_id, 'GOV-CICD-002', 'Workflow VTID in run-name',
            'All workflows SHOULD include VTID reference in run-name field for tracking.',
            'L2', ARRAY['CI'],
            ARRAY['.github/workflows/PHASE-2B-NAMING-ENFORCEMENT.yml'],
            ARRAY['DEV-CICDL-0033'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-CICD-002", "type": "naming"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_cicd_cat_id, 'GOV-CICD-003', 'File Naming Convention (kebab-case)',
            'All TypeScript/JavaScript code files MUST use kebab-case naming (e.g., my-service.ts). Exceptions: README, LICENSE, CHANGELOG, Dockerfile, Makefile.',
            'L2', ARRAY['CI'],
            ARRAY['.github/workflows/PHASE-2B-NAMING-ENFORCEMENT.yml'],
            ARRAY['DEV-CICDL-0033'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-CICD-003", "type": "naming"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_cicd_cat_id, 'GOV-CICD-004', 'Service Manifest Required',
            'Every service directory (agents, MCP services, gateway, deploy-watcher) MUST contain a manifest.json with required fields: name, and either vtid or vt_layer/vt_module.',
            'L2', ARRAY['CI'],
            ARRAY['.github/workflows/CICDL-CORE-LINT-SERVICES.yml'],
            ARRAY['DEV-CICDL-0033'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-CICD-004", "type": "structural"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_cicd_cat_id, 'GOV-CICD-005', 'Top-Level Service Directory Naming',
            'Top-level service directories MUST use kebab-case. Internal subdirectories may follow language conventions.',
            'L2', ARRAY['CI'],
            ARRAY['.github/workflows/CICDL-CORE-LINT-SERVICES.yml'],
            ARRAY['DEV-CICDL-0033'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-CICD-005", "type": "naming"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_cicd_cat_id, 'GOV-CICD-006', 'OpenAPI Spectral Validation',
            'All OpenAPI specification files in specs/ and packages/openapi/ MUST pass Spectral validation with fail-severity=warn.',
            'L2', ARRAY['CI'],
            ARRAY['.github/workflows/CICDL-CORE-OPENAPI-ENFORCE.yml'],
            ARRAY['DEV-CICDL-0033'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-CICD-006", "type": "validation"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_cicd_cat_id, 'GOV-CICD-007', 'OpenAPI Version Requirement',
            'All OpenAPI specs MUST use version 3.0.x or 3.1.x. Older versions are not supported.',
            'L2', ARRAY['CI'],
            ARRAY['.github/workflows/CICDL-CORE-OPENAPI-ENFORCE.yml'],
            ARRAY['DEV-CICDL-0033'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-CICD-007", "type": "validation"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_cicd_cat_id, 'GOV-CICD-008', 'No Duplicate Operation IDs',
            'Each OpenAPI operation MUST have a unique operationId within a specification. Duplicate operationIds are not allowed.',
            'L2', ARRAY['CI'],
            ARRAY['.github/workflows/CICDL-CORE-OPENAPI-ENFORCE.yml'],
            ARRAY['DEV-CICDL-0033'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-CICD-008", "type": "validation"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_cicd_cat_id, 'GOV-CICD-009', 'Prisma Schema Check',
            'Prisma schema MUST pass format --check validation. Schema generation and formatting are verified in CI.',
            'L2', ARRAY['CI'],
            ARRAY['.github/workflows/OASIS-PERSISTENCE.yml'],
            ARRAY['DEV-OASIS-GOV-0102'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-CICD-009", "type": "validation"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    -- DATABASE GOVERNANCE RULES (L1)
    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_db_cat_id, 'GOV-DB-001', 'RLS Enabled on Governance Tables',
            'Row Level Security MUST be enabled on all governance tables: governance_categories, governance_rules, governance_evaluations, governance_violations, governance_enforcements.',
            'L1', ARRAY['DB'],
            ARRAY['supabase/migrations/20251120000000_init_governance.sql'],
            ARRAY['DEV-OASIS-GOV-0102'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-DB-001", "type": "security"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_db_cat_id, 'GOV-DB-002', 'Service Role Write Access',
            'Write access to governance tables is restricted to service_role only. Backend services use service_role for all write operations.',
            'L1', ARRAY['DB', 'backend'],
            ARRAY['supabase/migrations/20251120000000_init_governance.sql'],
            ARRAY['DEV-OASIS-GOV-0102'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-DB-002", "type": "security"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_db_cat_id, 'GOV-DB-003', 'Authenticated Read Access',
            'Authenticated users have read-only access to governance tables for transparency.',
            'L1', ARRAY['DB'],
            ARRAY['supabase/migrations/20251120000000_init_governance.sql'],
            ARRAY['DEV-OASIS-GOV-0102'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-DB-003", "type": "security"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_db_cat_id, 'GOV-DB-004', 'OASIS Events Tenant Isolation',
            'OasisEvent table has RLS enabled with tenant-aware reads. Users can only SELECT events matching their JWT tenant claim.',
            'L1', ARRAY['DB'],
            ARRAY['database/policies/002_oasis_events.sql'],
            ARRAY['DEV-OASIS-GOV-0102'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-DB-004", "type": "security"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_db_cat_id, 'GOV-DB-005', 'OASIS Events Service Insert Only',
            'Only service_role can INSERT into OasisEvent table. Gateway backend uses service_role for event ingestion.',
            'L1', ARRAY['DB', 'backend'],
            ARRAY['database/policies/002_oasis_events.sql'],
            ARRAY['DEV-OASIS-GOV-0102'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-DB-005", "type": "security"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_db_cat_id, 'GOV-DB-006', 'VtidLedger RLS Policies',
            'VtidLedger table has RLS enabled. Authenticated users can read all VTIDs, insert new VTIDs, and update only their tenant''s VTIDs (or if admin).',
            'L1', ARRAY['DB'],
            ARRAY['database/policies/003_vtid_ledger.sql'],
            ARRAY['DEV-VTID-LEDGER'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-DB-006", "type": "security"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    -- AGENT GOVERNANCE RULES (L4)
    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_agent_cat_id, 'GOV-AGENT-001', 'Claude Operational Protocol (COP)',
            'Claude operates as Chief Autonomous Execution Officer under CEO/CTO governance. All tasks must honor OASIS as Single Source of Truth and preserve deterministic reproducibility.',
            'L4', ARRAY['agents'],
            ARRAY['docs/GOVERNANCE/CLAUDE_START_PROMPT.md'],
            ARRAY['COP-V1.0'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-AGENT-001", "type": "protocol"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_agent_cat_id, 'GOV-AGENT-002', 'VTID Required for All Tasks',
            'Every task executed by Claude or agents MUST include a VTID in its header (e.g., DEV-COMMU-0050). Tasks without VTID are invalid.',
            'L4', ARRAY['agents', 'CI'],
            ARRAY['docs/GOVERNANCE/CLAUDE_START_PROMPT.md'],
            ARRAY['COP-V1.0'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-AGENT-002", "type": "protocol"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_agent_cat_id, 'GOV-AGENT-003', 'No Direct Push to Main',
            'No direct pushes to main branch unless CEO explicitly orders. All changes must go through a PR with structured body including Summary, Context, Implementation details, Validation evidence, and OASIS event reference.',
            'L4', ARRAY['agents', 'CI'],
            ARRAY['docs/GOVERNANCE/CLAUDE_START_PROMPT.md'],
            ARRAY['COP-V1.0'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-AGENT-003", "type": "protocol"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_agent_cat_id, 'GOV-AGENT-004', 'Command Hierarchy',
            'Command hierarchy must be respected: CEO (Ultimate authority) > CTO/OASIS (Governance layer) > Claude (Executor) > Gemini/Worker Agents > Validator Agents. Claude never overrides CEO or OASIS directives.',
            'L4', ARRAY['agents'],
            ARRAY['docs/GOVERNANCE/CLAUDE_START_PROMPT.md'],
            ARRAY['COP-V1.0'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-AGENT-004", "type": "protocol"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_agent_cat_id, 'GOV-AGENT-005', 'Exact-Match Edit Protocol',
            'Claude must verify exact target snippet exists before modification. If snippet not found: STOP immediately, report mismatch, do not improvise or guess. Escalate to CEO for correction.',
            'L4', ARRAY['agents'],
            ARRAY['docs/GOVERNANCE/CLAUDE_START_PROMPT.md'],
            ARRAY['COP-V1.0'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-AGENT-005", "type": "protocol"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_agent_cat_id, 'GOV-AGENT-006', 'Telemetry Event Emission',
            'Every execution must emit a telemetry event to OASIS including: service name, VTID, start/end timestamps, outcome (success/warning/failure), and files touched.',
            'L4', ARRAY['agents', 'backend'],
            ARRAY['docs/GOVERNANCE/CLAUDE_START_PROMPT.md'],
            ARRAY['COP-V1.0'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-AGENT-006", "type": "protocol"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_agent_cat_id, 'GOV-AGENT-007', 'Safety and Validation Framework',
            'Claude must: validate all JSON/YAML schemas before commit, never expose secrets/API keys, treat OASIS/Gateway/Supabase credentials as secure, default to read-only unless explicitly instructed.',
            'L4', ARRAY['agents'],
            ARRAY['docs/GOVERNANCE/CLAUDE_START_PROMPT.md'],
            ARRAY['COP-V1.0'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-AGENT-007", "type": "protocol"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    -- API GOVERNANCE RULES (L2)
    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_api_cat_id, 'GOV-API-001', 'VTID Required in API Requests',
            'API requests requiring traceability MUST include VTID via X-VTID header, body parameter, or query parameter. Middleware enforces this requirement.',
            'L2', ARRAY['backend'],
            ARRAY['services/gateway/src/middleware/require-vtid.ts'],
            ARRAY['DEV-API-GOVERNANCE'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-API-001", "type": "traceability"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_api_cat_id, 'GOV-API-002', 'Health Endpoint Requirement',
            'All deployed services MUST expose health endpoints (/alive, /healthz, or /health) that return 200 status. CI deployment workflows verify health after deploy.',
            'L2', ARRAY['backend', 'CI'],
            ARRAY['.github/workflows/EXEC-DEPLOY.yml', 'services/gateway/src/routes/command-hub.ts'],
            ARRAY['DEV-CICDL-DEPLOY'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-API-002", "type": "monitoring"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

    INSERT INTO governance_rules (tenant_id, category_id, rule_id, name, description, level, enforcement, sources, vtids, commit_hash, catalog_version, is_active, logic)
    VALUES (v_tenant_id, v_api_cat_id, 'GOV-API-003', 'Deployment Version Recording',
            'All deployments MUST record software version in OASIS via /api/v1/operator/deployments endpoint including: service name, git commit, deploy type, initiator, and environment.',
            'L2', ARRAY['CI', 'backend'],
            ARRAY['.github/workflows/EXEC-DEPLOY.yml'],
            ARRAY['VTID-0510'], v_commit_hash, '0.1', TRUE, '{"rule_code": "GOV-API-003", "type": "traceability"}'::jsonb)
    ON CONFLICT (rule_id) DO UPDATE SET description = EXCLUDED.description, commit_hash = EXCLUDED.commit_hash;

END $$;

-- 9. Update catalog counts
UPDATE governance_catalog
SET
    rules_count = (SELECT COUNT(*) FROM governance_rules WHERE catalog_version = '0.1'),
    categories_count = (SELECT COUNT(*) FROM governance_categories WHERE code IS NOT NULL),
    updated_at = NOW()
WHERE version = '0.1';

-- 10. Log governance catalog initialization event
DO $$
BEGIN
    -- Log to OASIS if table exists
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'oasis_events_v1') THEN
        INSERT INTO oasis_events_v1 (tenant, service, vtid, topic, status, notes, metadata)
        VALUES (
            'SYSTEM',
            'governance-catalog',
            'VTID-0400',
            'GOVERNANCE_CATALOG_INITIALIZED',
            'success',
            'Governance catalog v0.1 initialized with 35 rules across 6 categories',
            '{"version": "0.1", "rules_count": 35, "categories_count": 6}'::jsonb
        );
    END IF;
END $$;
