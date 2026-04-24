-- =============================================================================
-- Dev Autopilot — allow source_type='dev_autopilot_impact' on recommendations
-- =============================================================================
-- The impact scanner (PR-time, diff-aware) emits findings that should live
-- in the same queue as the baseline scanners, but tagged with their own
-- source_type so the Developer Autopilot view can filter + style them
-- differently. Their lifecycle is shorter than baseline findings:
-- companion/conflict/semantic issues typically resolve in a single follow-up PR.
--
-- Current check (from 20260416100000_dev_autopilot.sql):
--   CHECK (source_type IN ('community', 'dev_autopilot', 'system'))
--
-- After this migration:
--   CHECK (source_type IN ('community', 'dev_autopilot', 'dev_autopilot_impact', 'system'))
-- =============================================================================

ALTER TABLE public.autopilot_recommendations
  DROP CONSTRAINT IF EXISTS autopilot_recommendations_source_type_check;

ALTER TABLE public.autopilot_recommendations
  ADD CONSTRAINT autopilot_recommendations_source_type_check
  CHECK (source_type IN ('community', 'dev_autopilot', 'dev_autopilot_impact', 'system'));

-- Partial unique index for dedup — same fingerprint doesn't re-insert while
-- a finding is still live (status=new or snoozed). Uses spec_snapshot->>'rule'
-- + spec_snapshot->>'fingerprint' so re-scans bump seen_count via upsert.
--
-- Separate index from the baseline 20260416100000 uq_autopilot_dev_fingerprint_active
-- so impact + baseline scanners can't collide on fingerprint.
CREATE UNIQUE INDEX IF NOT EXISTS uq_autopilot_impact_fingerprint_active
  ON public.autopilot_recommendations (source_type, signal_fingerprint)
  WHERE source_type = 'dev_autopilot_impact'
    AND signal_fingerprint IS NOT NULL
    AND status IN ('new', 'snoozed');

CREATE INDEX IF NOT EXISTS idx_autopilot_impact_queue
  ON public.autopilot_recommendations (source_type, status, created_at DESC)
  WHERE source_type = 'dev_autopilot_impact';
