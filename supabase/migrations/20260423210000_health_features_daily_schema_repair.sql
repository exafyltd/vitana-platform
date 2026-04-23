-- =============================================================================
-- health_features_daily — schema repair (BOOTSTRAP-HEALTH-FEATURES-REPAIR)
-- Date: 2026-04-23
--
-- Live DB created this table from the older VTID-01078 c1 migration which
-- did NOT include feature_unit / sample_count / confidence / metadata /
-- updated_at. The subsequent VTID-01103 migration used CREATE TABLE IF
-- NOT EXISTS so those columns were never added. The Manual Data Entry
-- endpoint (step 9) tries to write `confidence` and fails with
-- "Could not find the 'confidence' column".
--
-- Same class of drift that was repaired on vitana_index_scores earlier.
-- Idempotent: ALTER TABLE ADD COLUMN IF NOT EXISTS.
-- =============================================================================

BEGIN;

ALTER TABLE public.health_features_daily
  ADD COLUMN IF NOT EXISTS feature_unit TEXT,
  ADD COLUMN IF NOT EXISTS sample_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS confidence NUMERIC DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::JSONB,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

COMMENT ON COLUMN public.health_features_daily.confidence IS
  '0.0-1.0 confidence score. Added 2026-04-23 schema repair (same drift that hit vitana_index_scores earlier).';

NOTIFY pgrst, 'reload schema';

COMMIT;
