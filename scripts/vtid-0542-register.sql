-- VTID-0542 Registration Script
-- Run this to register VTID-0542 in OASIS before deploying

-- Insert VTID-0542 into vtid_ledger
INSERT INTO "VtidLedger" (
    id,
    vtid,
    task_family,
    task_type,
    layer,
    module,
    title,
    description,
    summary,
    status,
    tenant,
    is_test,
    metadata,
    created_at,
    updated_at
) VALUES (
    gen_random_uuid()::TEXT,
    'VTID-0542',
    'DEV',
    'ALLOCATOR',
    'DEV',
    'VTID',
    'Global VTID Allocator + 3-Path Cutover',
    'Create a single global VTID allocator used by all 3 task-creation paths (Manual/CTO, Operator Console, Command Hub) with atomic sequential numbering starting at VTID-01000.',
    'Implements D1-D6: Atomic allocator, feature flags, 3-path wiring, orphan-deploy hard gate',
    'in_progress',
    'vitana',
    false,
    jsonb_build_object(
        'deliverables', jsonb_build_array(
            'D1: Atomic VTID allocator with sequence',
            'D2: Feature flags VTID_ALLOCATOR_ENABLED/START',
            'D3: Operator Console chat wired to allocator',
            'D4: Command Hub +Task wired to allocator',
            'D5: Manual path rule enforcement guard',
            'D6: Orphan-deploy gate upgraded to hard fail'
        ),
        'activation_rule', 'Allocator flips ON when all 3 paths verified',
        'start_vtid', 'VTID-01000'
    ),
    NOW(),
    NOW()
)
ON CONFLICT (vtid) DO UPDATE SET
    title = EXCLUDED.title,
    description = EXCLUDED.description,
    summary = EXCLUDED.summary,
    metadata = EXCLUDED.metadata,
    updated_at = NOW();

-- Verify registration
SELECT vtid, title, status, created_at FROM "VtidLedger" WHERE vtid = 'VTID-0542';
