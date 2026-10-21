-- DATA FIXUP — VTID-02689
--
-- FB-2026-05-000032's autopilot_recommendations row (id cf6b0317-...)
-- was created BEFORE VTID-02672 added spec_snapshot.proposed_files. The
-- bridge's orphan-reuse path (VTID-02674) returns this stale finding on
-- every retry, so spec_snapshot.proposed_files stays NULL forever and
-- the executor's fallback (VTID-02687) has nothing to fall back to.
--
-- Devon's spec_md on the linked feedback_ticket lists the correct files
-- in its "Files to touch" section. Backfill those into the recommendation
-- so the next /activate retry can dispatch with valid files.

UPDATE public.autopilot_recommendations
SET spec_snapshot = jsonb_set(
  COALESCE(spec_snapshot, '{}'::jsonb),
  '{proposed_files}',
  '["services/gateway/src/services/persona-registry.ts", "services/gateway/src/services/persona-registry.test.ts"]'::jsonb
)
WHERE source_ref = 'feedback_ticket:f85298f4-e1d1-48c8-bb10-faf7efc6d11c'
  AND (spec_snapshot->'proposed_files' IS NULL
       OR jsonb_typeof(spec_snapshot->'proposed_files') = 'null'
       OR jsonb_array_length(COALESCE(spec_snapshot->'proposed_files', '[]'::jsonb)) = 0);

-- Sanity check
SELECT
  id,
  source_ref,
  spec_snapshot->'proposed_files' AS proposed_files,
  spec_snapshot->>'signal_type'   AS signal_type,
  spec_snapshot->>'file_path'     AS file_path
FROM public.autopilot_recommendations
WHERE source_ref = 'feedback_ticket:f85298f4-e1d1-48c8-bb10-faf7efc6d11c';
