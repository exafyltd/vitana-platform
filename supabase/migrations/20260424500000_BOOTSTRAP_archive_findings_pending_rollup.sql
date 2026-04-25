-- =============================================================================
-- Dev Autopilot — archive scattered findings ahead of synthesis-layer rollup
-- =============================================================================
-- The matching gateway PR adds a system-wide rollup rule to ingestScan():
-- any cluster of ≥5 signals from the same (scanner, signal_type, severity)
-- collapses into ONE rollup finding instead of N individual rows.
--
-- The existing queue contains many such clusters from earlier scans that
-- predate the rule:
--   schema-drift-scanner-v1     ~60 findings
--   dead-code-scanner-v1       ~250 findings
--   missing-tests-scanner-v1   ~340 findings
--   stale-feature-flag-scanner-v1 ~12 findings
--   ... and any future scanner that emits a noisy class
--
-- After this migration runs, the next scan cycle will re-ingest those
-- scanners' signals and produce one rollup finding per cluster — instead
-- of the operator clicking through hundreds of duplicates.
--
-- The archive is parameterized: archive any (scanner, signal_type, severity)
-- group that has ≥5 status='new' rows. Generic, applies to current AND
-- future scanner output. Same operators can re-run this query manually any
-- time the queue gets cluttered (or we can wire it into the scanner runner
-- as a periodic cleanup step in a follow-up).
-- =============================================================================

WITH noisy_clusters AS (
  SELECT
    spec_snapshot->>'scanner'      AS scanner_key,
    COALESCE(spec_snapshot->>'signal_type', '')   AS signal_type_key,
    risk_class
  FROM autopilot_recommendations
  WHERE source_type IN ('dev_autopilot', 'dev_autopilot_impact')
    AND status = 'new'
    AND spec_snapshot ? 'scanner'
    -- Skip rows that already are rollups — they're the answer, not the noise.
    AND COALESCE((spec_snapshot->>'rollup')::boolean, FALSE) IS NOT TRUE
  GROUP BY 1, 2, 3
  HAVING COUNT(*) >= 5
)
UPDATE autopilot_recommendations r
SET
  status = 'auto_archived',
  spec_snapshot = jsonb_set(
    COALESCE(r.spec_snapshot, '{}'::jsonb),
    '{archived_reason}',
    to_jsonb('queued ahead of synthesis-layer rollup (cluster ≥5 will re-emit as rollup on next scan, 2026-04-24)'::text)
  ),
  auto_archive_at = NOW(),
  updated_at = NOW()
FROM noisy_clusters n
WHERE r.source_type IN ('dev_autopilot', 'dev_autopilot_impact')
  AND r.status = 'new'
  AND r.spec_snapshot->>'scanner' = n.scanner_key
  AND COALESCE(r.spec_snapshot->>'signal_type', '') = n.signal_type_key
  AND r.risk_class IS NOT DISTINCT FROM n.risk_class
  AND COALESCE((r.spec_snapshot->>'rollup')::boolean, FALSE) IS NOT TRUE;
