-- VTID-01992: Backfill ledger entry for the embedding worker (gateway deploy gate).
--
-- The EXEC-DEPLOY HARD GATE (VTID-0542) blocks the gateway deploy until
-- the VTID extracted from the merge commit exists in VtidLedger. This
-- migration registers VTID-01992 manually so the deploy can proceed.
--
-- Idempotent — ON CONFLICT DO NOTHING in case the row was already
-- inserted by a parallel allocate call.

INSERT INTO "VtidLedger" (
    id, vtid, task_family, task_type, layer, module,
    title, description, status, tenant, is_test, metadata,
    created_at, updated_at
)
VALUES (
    gen_random_uuid()::TEXT,
    'VTID-01992',
    'INTENT',
    'feature',
    'INF',
    'INTENT',
    'Async intent embedding worker — promote off post path',
    'Polls user_intents WHERE embedding IS NULL ORDER BY created_at LIMIT 16 every 5s; embeds via Gemini; FEATURE_INTENT_EMBEDDING_ASYNC controls inline-skip on POST.',
    'allocated',
    'vitana',
    false,
    jsonb_build_object(
        'source', 'manual-backfill',
        'allocated_at', NOW()::TEXT,
        'allocator_version', 'VTID-0542',
        'pr_url', 'https://github.com/exafyltd/vitana-platform/pull/991',
        'reason', 'deploy-gate-backfill'
    ),
    NOW(),
    NOW()
)
ON CONFLICT (vtid) DO NOTHING;
