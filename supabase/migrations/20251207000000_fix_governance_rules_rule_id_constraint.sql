-- ============================================================
-- VTID-0403: Fix governance_rules.rule_id ON CONFLICT support
-- ============================================================
-- Problem: The 20251203000000_governance_catalog_init.sql migration uses
-- ON CONFLICT (rule_id) but only a plain INDEX existed, not a UNIQUE constraint.
-- PostgreSQL requires a UNIQUE constraint (or unique index) for ON CONFLICT.
--
-- This migration:
-- 1. Drops the stale idx_rules_rule_id index if it exists
-- 2. Adds a proper UNIQUE constraint on rule_id
-- ============================================================

DO $$
BEGIN
    -- Drop old index if it still exists
    IF EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'idx_rules_rule_id'
          AND n.nspname = 'public'
    ) THEN
        DROP INDEX IF EXISTS idx_rules_rule_id;
        RAISE NOTICE 'Dropped stale index idx_rules_rule_id';
    END IF;

    -- Add unique constraint on governance_rules.rule_id if not present
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'governance_rules_rule_id_key'
          AND conrelid = 'governance_rules'::regclass
    ) THEN
        ALTER TABLE governance_rules
            ADD CONSTRAINT governance_rules_rule_id_key UNIQUE (rule_id);
        RAISE NOTICE 'Added UNIQUE constraint governance_rules_rule_id_key on rule_id';
    ELSE
        RAISE NOTICE 'Constraint governance_rules_rule_id_key already exists';
    END IF;
END $$;

-- Log the fix to OASIS
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'oasis_events_v1') THEN
        INSERT INTO oasis_events_v1 (tenant, service, vtid, topic, status, notes, metadata)
        VALUES (
            'SYSTEM',
            'governance-catalog',
            'VTID-0403',
            'GOVERNANCE_RULE_ID_CONSTRAINT_FIXED',
            'success',
            'Fixed governance_rules.rule_id to have UNIQUE constraint for ON CONFLICT support',
            '{"fix": "replaced plain index with UNIQUE constraint", "constraint_name": "governance_rules_rule_id_key"}'::jsonb
        );
    END IF;
END $$;
