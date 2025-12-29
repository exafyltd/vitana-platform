-- VTID-01063 Registration Script
-- Duplicate Route Guard (Governance Hard Gate)
-- Run this to register VTID-01063 in OASIS before deploying

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
    'VTID-01063',
    'GOVERNANCE',
    'SAFETY',
    'PLATFORM',
    'GATEWAY',
    'Gateway Duplicate Route Guard (Governance Hard Gate)',
    'Implement a Duplicate Route Guard in the Gateway so that no two handlers can register the same effective endpoint (method + full path) without being detected and blocked. Enforced at startup (runtime safety) and in tests/CI (merge blocker).',
    'Route Guard prevents duplicate route registration. Platform invariant: One endpoint = one authoritative handler.',
    'in_progress',
    'vitana',
    false,
    jsonb_build_object(
        'type', 'governance_hard_gate',
        'problem_vtid', 'VTID-01058',
        'problem', 'Route ambiguity from duplicate /api/v1/commandhub/board handlers',
        'solution', 'mountRouter helper with in-memory registry',
        'enforcement', 'startup crash (dev/test) + OASIS event (prod)',
        'files', jsonb_build_array(
            'services/gateway/src/governance/route-guard.ts',
            'services/gateway/src/index.ts',
            'services/gateway/test/route-guard.test.ts'
        )
    ),
    NOW(),
    NOW()
)
ON CONFLICT (vtid) DO UPDATE SET
    title = EXCLUDED.title,
    description = EXCLUDED.description,
    summary = EXCLUDED.summary,
    status = EXCLUDED.status,
    metadata = EXCLUDED.metadata,
    updated_at = NOW();

SELECT vtid, title, status FROM "VtidLedger" WHERE vtid = 'VTID-01063';
