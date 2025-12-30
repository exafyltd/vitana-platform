-- VTID-01079 Registration Script
-- Command Hub Board Determinism (Status→Column Map + One-Row-Per-VTID + DEV Filter)
-- Run this to register VTID-01079 in OASIS before deploying

INSERT INTO vtid_ledger (
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
    'VTID-01079',
    'GOVERNANCE',
    'DETERMINISM',
    'PLATFORM',
    'GATEWAY',
    'Command Hub Board Determinism (Status→Column Map + One-Row-Per-VTID + DEV Filter)',
    'Stop tasks moving columns by making /api/v1/commandhub/board deterministic and stable: (1) Deterministic status→column mapping (no defaults, no inference), (2) One row per VTID (dedupe guarantees), (3) Optional namespace filter so VTID board can exclude DEV-* without breaking existing behavior.',
    'Deterministic board output: canonical status→column mapping, one-row-per-VTID deduplication, and optional DEV filter.',
    'in_progress',
    'vitana',
    false,
    jsonb_build_object(
        'type', 'determinism_fix',
        'hard_invariants', jsonb_build_array(
            'completed → COMPLETED',
            'in_progress → IN_PROGRESS',
            'pending → SCHEDULED',
            'scheduled → SCHEDULED'
        ),
        'query_params', jsonb_build_object(
            'include_dev', 'boolean, default true'
        ),
        'response_fields', jsonb_build_object(
            'id_namespace', 'VTID | DEV | OTHER'
        ),
        'files', jsonb_build_array(
            'services/gateway/src/routes/board-adapter.ts'
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

SELECT vtid, title, status FROM vtid_ledger WHERE vtid = 'VTID-01079';
