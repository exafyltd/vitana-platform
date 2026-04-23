-- =============================================================================
-- Dev Autopilot — one-shot archive of scanner false-positive findings
-- =============================================================================
-- The missing-tests-scanner-v1 ran for months with no quality filters. It
-- produced ~338 "Add missing tests for X" findings, ~60-80 of which target
-- files that don't warrant unit tests: types.ts, constants.ts, config.ts,
-- defaults.ts, registry.ts, barrel index.ts re-exports, and very small
-- files that are too thin to cover meaningfully.
--
-- The scanner was tightened in the same PR as this migration (scripts/ci/
-- dev-autopilot-scan.mjs). This statement retroactively archives the rows
-- that the tightened scanner would no longer emit, so operators don't have
-- to wait for the scanner to re-run before the queue clears.
--
-- Safe because:
--   - Only touches status='new' rows (nothing in execute/merge flight).
--   - Bounded to source_type='dev_autopilot' with scanner='missing-tests-scanner-v1'.
--   - Writes the reason into spec_snapshot.archived_reason so the audit
--     trail survives in the JSONB blob.
--
-- Uses the existing 'auto_archived' status value established by the parent
-- dev_autopilot schema migration (20260416100000).
-- =============================================================================

UPDATE autopilot_recommendations
SET
  status = 'auto_archived',
  spec_snapshot = jsonb_set(
    COALESCE(spec_snapshot, '{}'::jsonb),
    '{archived_reason}',
    to_jsonb('scanner-false-positive (size/pattern/pure-export filter, 2026-04-23)'::text)
  ),
  auto_archive_at = NOW(),
  updated_at = NOW()
WHERE source_type = 'dev_autopilot'
  AND status = 'new'
  AND spec_snapshot ->> 'scanner' = 'missing-tests-scanner-v1'
  AND (
    -- Filename denylist: types/constants/config/defaults/registry/index modules.
    spec_snapshot ->> 'file_path' ~ '/(types|constants|config|defaults|registry|index)\.ts$'
    -- Size floor: anything shorter than the new MISSING_TESTS_MIN_LOC default.
    -- file_loc is written by the updated scanner; older rows won't have it
    -- and will fall through to the filename filter above.
    OR (
      spec_snapshot ? 'file_loc'
      AND (spec_snapshot ->> 'file_loc')::int < 50
    )
  );
