-- ============================================================
-- FIX GOVERNANCE RULE LEVELS
-- VTID: VTID-0401-B
-- Purpose: Correct rule levels to match specs/governance/rules.json
-- Expected: 35 rules with L1(6), L2(14), L3(8), L4(7)
-- ============================================================

-- Update all governance rule levels to match the canonical source
-- This fixes any rules that were inserted with incorrect levels

DO $$
BEGIN
    -- MIGRATION GOVERNANCE RULES -> L3 (7 rules)
    UPDATE governance_rules SET level = 'L3' WHERE rule_id = 'GOV-MIGRATION-001';
    UPDATE governance_rules SET level = 'L3' WHERE rule_id = 'GOV-MIGRATION-002';
    UPDATE governance_rules SET level = 'L3' WHERE rule_id = 'GOV-MIGRATION-003';
    UPDATE governance_rules SET level = 'L3' WHERE rule_id = 'GOV-MIGRATION-004';
    UPDATE governance_rules SET level = 'L3' WHERE rule_id = 'GOV-MIGRATION-005';
    UPDATE governance_rules SET level = 'L3' WHERE rule_id = 'GOV-MIGRATION-006';
    UPDATE governance_rules SET level = 'L3' WHERE rule_id = 'GOV-MIGRATION-007';

    -- FRONTEND GOVERNANCE RULES
    UPDATE governance_rules SET level = 'L3' WHERE rule_id = 'GOV-FRONTEND-001';  -- L3
    UPDATE governance_rules SET level = 'L2' WHERE rule_id = 'GOV-FRONTEND-002';  -- L2
    UPDATE governance_rules SET level = 'L2' WHERE rule_id = 'GOV-FRONTEND-003';  -- L2

    -- CI/CD GOVERNANCE RULES -> L2 (9 rules)
    UPDATE governance_rules SET level = 'L2' WHERE rule_id = 'GOV-CICD-001';
    UPDATE governance_rules SET level = 'L2' WHERE rule_id = 'GOV-CICD-002';
    UPDATE governance_rules SET level = 'L2' WHERE rule_id = 'GOV-CICD-003';
    UPDATE governance_rules SET level = 'L2' WHERE rule_id = 'GOV-CICD-004';
    UPDATE governance_rules SET level = 'L2' WHERE rule_id = 'GOV-CICD-005';
    UPDATE governance_rules SET level = 'L2' WHERE rule_id = 'GOV-CICD-006';
    UPDATE governance_rules SET level = 'L2' WHERE rule_id = 'GOV-CICD-007';
    UPDATE governance_rules SET level = 'L2' WHERE rule_id = 'GOV-CICD-008';
    UPDATE governance_rules SET level = 'L2' WHERE rule_id = 'GOV-CICD-009';

    -- DATABASE GOVERNANCE RULES -> L1 (6 rules)
    UPDATE governance_rules SET level = 'L1' WHERE rule_id = 'GOV-DB-001';
    UPDATE governance_rules SET level = 'L1' WHERE rule_id = 'GOV-DB-002';
    UPDATE governance_rules SET level = 'L1' WHERE rule_id = 'GOV-DB-003';
    UPDATE governance_rules SET level = 'L1' WHERE rule_id = 'GOV-DB-004';
    UPDATE governance_rules SET level = 'L1' WHERE rule_id = 'GOV-DB-005';
    UPDATE governance_rules SET level = 'L1' WHERE rule_id = 'GOV-DB-006';

    -- AGENT GOVERNANCE RULES -> L4 (7 rules)
    UPDATE governance_rules SET level = 'L4' WHERE rule_id = 'GOV-AGENT-001';
    UPDATE governance_rules SET level = 'L4' WHERE rule_id = 'GOV-AGENT-002';
    UPDATE governance_rules SET level = 'L4' WHERE rule_id = 'GOV-AGENT-003';
    UPDATE governance_rules SET level = 'L4' WHERE rule_id = 'GOV-AGENT-004';
    UPDATE governance_rules SET level = 'L4' WHERE rule_id = 'GOV-AGENT-005';
    UPDATE governance_rules SET level = 'L4' WHERE rule_id = 'GOV-AGENT-006';
    UPDATE governance_rules SET level = 'L4' WHERE rule_id = 'GOV-AGENT-007';

    -- API GOVERNANCE RULES -> L2 (3 rules)
    UPDATE governance_rules SET level = 'L2' WHERE rule_id = 'GOV-API-001';
    UPDATE governance_rules SET level = 'L2' WHERE rule_id = 'GOV-API-002';
    UPDATE governance_rules SET level = 'L2' WHERE rule_id = 'GOV-API-003';

    RAISE NOTICE 'Governance rule levels updated successfully';
END $$;

-- Validation query (for documentation/verification)
-- Expected results:
--   L1: 6 rules (GOV-DB-*)
--   L2: 14 rules (GOV-FRONTEND-002/003, GOV-CICD-*, GOV-API-*)
--   L3: 8 rules (GOV-MIGRATION-*, GOV-FRONTEND-001)
--   L4: 7 rules (GOV-AGENT-*)
-- Total: 35 rules

-- Log the fix
DO $$
BEGIN
    -- oasis_events_v1 columns: tenant, task_type, assignee_ai, rid, status, notes, metadata
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'oasis_events_v1') THEN
        INSERT INTO oasis_events_v1 (tenant, task_type, assignee_ai, rid, status, notes, metadata)
        VALUES (
            'SYSTEM',
            'governance-catalog',
            'system',
            'VTID-0401-B-levels-fix',
            'success',
            'Governance rule levels corrected to match specs/governance/rules.json',
            jsonb_build_object(
                'expected_counts', jsonb_build_object(
                    'L1', 6,
                    'L2', 14,
                    'L3', 8,
                    'L4', 7,
                    'total', 35
                )
            )
        );
    END IF;
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'Could not log to oasis_events_v1: %', SQLERRM;
END $$;
