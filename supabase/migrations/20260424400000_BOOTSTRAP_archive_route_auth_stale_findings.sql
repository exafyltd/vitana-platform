-- =============================================================================
-- Dev Autopilot — archive stale route-auth findings
-- =============================================================================
-- The route-auth-scanner-v1 scanner got three fixes in this migration's
-- PR:
--   1. Expanded AUTH_NAMES (added requireTenantAdmin, requireIngestAuth,
--      requireAdminAuth — each used 30+ times across the gateway but
--      previously not recognized, producing ~40+ false positives).
--   2. Heuristic regex fallback — catches any `require<CapitalLetter>`
--      or `*Auth` named middleware even if we didn't enumerate it.
--   3. Mount-layer tracing — parses services/gateway/src/index.ts and
--      skips files mounted with auth middleware upstream.
--   4. Rollup emission — when ≥5 genuine findings remain, the scanner
--      collapses them into ONE finding for batch-fix in a single PR.
--
-- With the scanner fixed, the existing 122 per-file findings in the queue
-- are stale. The next scan cycle will re-emit a single rollup finding
-- covering whatever's still actually unauthed, so operators can action
-- the whole class in one PR instead of clicking through 122 items.
--
-- This migration archives every open route-auth finding. Idempotent via
-- status='auto_archived' (matches the pattern established by
-- 20260423150000 / the tripart PR).
-- =============================================================================

UPDATE autopilot_recommendations
SET
  status = 'auto_archived',
  spec_snapshot = jsonb_set(
    COALESCE(spec_snapshot, '{}'::jsonb),
    '{archived_reason}',
    to_jsonb('route-auth-scanner-v2 will re-emit a rollup for genuine gaps (2026-04-24)'::text)
  ),
  auto_archive_at = NOW(),
  updated_at = NOW()
WHERE source_type = 'dev_autopilot'
  AND status = 'new'
  AND spec_snapshot ->> 'scanner' = 'route-auth-scanner-v1';
