-- 20251120000003_fix_migration_governance_seed.sql
-- Fixes the apply failure of 20251120000001 (ON CONFLICT without unique constraint). Applied migrations are not edited.
--
-- Cause: 20251120000001 inserts into governance_categories with ON CONFLICT (tenant_id, name).
-- The CREATE TABLE in 20251120000000 declares UNIQUE (tenant_id, name), so a database built only from
-- this repo has that constraint. A database where governance_categories already existed skips the
-- CREATE TABLE (IF NOT EXISTS) and can lack the constraint. Then 20251120000001 fails.
--
-- Steps:
--   1. Unique guard. If no unique index covers exactly (tenant_id, name) with no predicate, this step:
--      a. Removes duplicate (tenant_id, name) rows, keeping the earliest by created_at, then id.
--         Rules that pointed at a removed row are repointed to the kept row first, so no rule loses its category.
--         Risk this covers: a partly applied earlier run could leave two rows with the same tenant_id and name,
--         and ADD CONSTRAINT would fail on them.
--      b. Adds governance_categories_tenant_id_name_key UNIQUE (tenant_id, name).
--   2. Seed. Same MIGRATION_GOVERNANCE category and MG-001 .. MG-007 rules as 20251120000001.
--      Category: inserted, or on an existing row only its description is updated (same as 20251120000001).
--      Rules: inserted only when no SYSTEM rule with that rule_code exists. Existing rule rows are not changed.
--
-- Idempotent: once the unique constraint exists, step 1 is skipped, and a re-run inserts no rows.

-- 1) Unique guard (de-duplicate, then add the constraint), only when no matching unique index exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    WHERE i.indrelid = 'public.governance_categories'::regclass
      AND i.indisunique
      AND i.indpred IS NULL
      AND i.indexprs IS NULL
      AND i.indnkeyatts = 2
      AND (
        SELECT array_agg(a.attname::text ORDER BY a.attname::text)
        FROM pg_attribute a
        WHERE a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey::int2[])
      ) = ARRAY['name', 'tenant_id']
  ) THEN
    -- Repoint rules from duplicate categories to the earliest row for the same (tenant_id, name).
    WITH ranked AS (
      SELECT id,
             first_value(id) OVER (
               PARTITION BY tenant_id, name
               ORDER BY created_at ASC NULLS LAST, id
             ) AS keep_id
      FROM governance_categories
    )
    UPDATE governance_rules r
    SET category_id = ranked.keep_id
    FROM ranked
    WHERE r.category_id = ranked.id
      AND ranked.id <> ranked.keep_id;

    -- Delete the duplicate category rows (never the earliest row).
    WITH ranked AS (
      SELECT id,
             first_value(id) OVER (
               PARTITION BY tenant_id, name
               ORDER BY created_at ASC NULLS LAST, id
             ) AS keep_id
      FROM governance_categories
    )
    DELETE FROM governance_categories c
    USING ranked
    WHERE c.id = ranked.id
      AND ranked.id <> ranked.keep_id;

    ALTER TABLE governance_categories
      ADD CONSTRAINT governance_categories_tenant_id_name_key UNIQUE (tenant_id, name);
  END IF;
END $$;

-- 2) Seed (same content as 20251120000001, now valid because the unique constraint exists).
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
