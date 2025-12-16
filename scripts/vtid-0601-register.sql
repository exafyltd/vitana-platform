-- VTID-0601 Registration Script
-- Run this to register VTID-0601 in OASIS before deploying

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
    'VTID-0601',
    'DEV',
    'CICD',
    'DEV',
    'CICD',
    'Fix GitHub PR fetch authentication in /api/v1/cicd/approvals',
    'Fix GitHub API authentication in the CICD approvals endpoint to use correct token resolution and header format.',
    'Token resolution: GITHUB_TOKEN || GH_TOKEN. Headers: Authorization Bearer + Accept vnd.github+json',
    'in_progress',
    'vitana',
    false,
    jsonb_build_object(
        'fix', 'GitHub PR fetch authentication',
        'endpoint', '/api/v1/cicd/approvals',
        'token_resolution', 'GITHUB_TOKEN || GH_TOKEN',
        'headers', 'Authorization: Bearer, Accept: application/vnd.github+json'
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

SELECT vtid, title, status FROM "VtidLedger" WHERE vtid = 'VTID-0601';
