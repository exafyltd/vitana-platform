-- VTID-01080 Registration Script
-- CI/CD Hard Gate: OASIS Terminal Completion Required
-- Run this to register VTID-01080 in OASIS before deploying

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
    'VTID-01080',
    'CICD',
    'HARD_GATE',
    'PLATFORM',
    'GATEWAY',
    'CI/CD Hard Gate: OASIS Terminal Completion Required',
    'A task is ONLY "done" if the pipeline writes a terminal completion update into OASIS. If that write does not happen, the pipeline FAILS. This implements hard governance for deployment success verification.',
    'Implements terminal completion hard gate: POST /api/v1/oasis/tasks/:vtid/complete with is_terminal=true, status=completed, terminal_outcome=success.',
    'in_progress',
    'vitana',
    false,
    jsonb_build_object(
        'type', 'cicd_hard_gate',
        'endpoint', 'POST /api/v1/oasis/tasks/:vtid/complete',
        'terminal_fields', jsonb_build_object(
            'status', 'completed',
            'is_terminal', true,
            'terminal_outcome', 'success | failed | cancelled'
        ),
        'workflow_step', 'OASIS Terminal Completion Gate (VTID-01080 HARD GATE)',
        'files', jsonb_build_array(
            'services/gateway/src/routes/oasis-tasks.ts',
            '.github/workflows/EXEC-DEPLOY.yml',
            'supabase/migrations/20251230000000_vtid_01080_terminal_completion.sql'
        ),
        'events', jsonb_build_array(
            'vtid.lifecycle.terminal_completion',
            'vtid.lifecycle.completion_gate.failed'
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

SELECT vtid, title, status FROM vtid_ledger WHERE vtid = 'VTID-01080';
