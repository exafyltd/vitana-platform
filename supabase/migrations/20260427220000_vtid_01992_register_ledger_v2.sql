-- VTID-01992: Backfill ledger entry (v2 — no ON CONFLICT, use NOT EXISTS guard).
-- Previous attempt (20260427210000) failed because VtidLedger has no UNIQUE
-- constraint on vtid; ON CONFLICT (vtid) DO NOTHING errored.

INSERT INTO "VtidLedger" (
    id, vtid, task_family, task_type, layer, module,
    title, description, status, tenant, is_test, metadata,
    created_at, updated_at
)
SELECT
    gen_random_uuid()::TEXT,
    'VTID-01992',
    'INTENT',
    'feature',
    'INF',
    'INTENT',
    'Async intent embedding worker — promote off post path',
    'Polls user_intents WHERE embedding IS NULL ORDER BY created_at LIMIT 16 every 5s; embeds via Gemini.',
    'allocated',
    'vitana',
    false,
    jsonb_build_object(
        'source', 'manual-backfill',
        'allocated_at', NOW()::TEXT,
        'pr_url', 'https://github.com/exafyltd/vitana-platform/pull/991',
        'reason', 'deploy-gate-backfill'
    ),
    NOW(),
    NOW()
WHERE NOT EXISTS (
    SELECT 1 FROM "VtidLedger" WHERE vtid = 'VTID-01992'
);
