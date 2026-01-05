-- VTID-01164 Registration Script
-- Run this to register VTID-01164 in OASIS before deploying

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
    'VTID-01164',
    'DEV',
    'AGENT',
    'OASIS',
    'WORKFORCE',
    'Sub-Agent Skill Pack v1 (Frontend/Backend/Memory + Common)',
    'Implement Skill Pack v1 for Worker Orchestrator + 3 subagents: analysis -> action -> validation with minimal repo scanning and fewer regressions.',
    'P0: check_memory_first, security_scan, validate_rls_policy. P1: preview_migration, analyze_service, validate_accessibility. YAML skill descriptors + TypeScript handlers.',
    'in_progress',
    'vitana',
    false,
    jsonb_build_object(
        'skills_p0', jsonb_build_array(
            'worker.common.check_memory_first',
            'worker.backend.security_scan',
            'worker.memory.validate_rls_policy'
        ),
        'skills_p1', jsonb_build_array(
            'worker.memory.preview_migration',
            'worker.backend.analyze_service',
            'worker.frontend.validate_accessibility'
        ),
        'parent_vtid', 'VTID-01163',
        'deliverables', jsonb_build_array(
            'crew_template/skills/*.yaml (6 files)',
            'services/agents/workforce/skills/*.ts (skill handlers)',
            'OASIS event emission for all skills'
        )
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

SELECT vtid, title, status FROM "VtidLedger" WHERE vtid = 'VTID-01164';
