-- =============================================================================
-- vitana_index_scores — schema repair: add the columns that
-- 20251231000000_vtid_01103_health_compute_engine.sql intended to create but
-- couldn't because the table was pre-created by the earlier VTID-01078 c1
-- migration with `CREATE TABLE IF NOT EXISTS`.
--
-- Missing columns the current gateway code + RPC depend on:
--   score_physical, score_nutritional, score_social, score_environmental,
--   feature_inputs, confidence, metadata, updated_at
--
-- `score_prosperity` is added by the proactive-guide phase0 migration (already
-- re-applied on 2026-04-23) — included here as IF NOT EXISTS to be safe.
--
-- `score_mental` already exists in both old and new schemas — same semantics.
--
-- Idempotent via IF NOT EXISTS. Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE public.vitana_index_scores
  ADD COLUMN IF NOT EXISTS score_physical INTEGER DEFAULT 0
    CHECK (score_physical IS NULL OR (score_physical >= 0 AND score_physical <= 200)),
  ADD COLUMN IF NOT EXISTS score_nutritional INTEGER DEFAULT 0
    CHECK (score_nutritional IS NULL OR (score_nutritional >= 0 AND score_nutritional <= 200)),
  ADD COLUMN IF NOT EXISTS score_social INTEGER DEFAULT 0
    CHECK (score_social IS NULL OR (score_social >= 0 AND score_social <= 200)),
  ADD COLUMN IF NOT EXISTS score_environmental INTEGER DEFAULT 0
    CHECK (score_environmental IS NULL OR (score_environmental >= 0 AND score_environmental <= 200)),
  ADD COLUMN IF NOT EXISTS score_prosperity SMALLINT DEFAULT 100
    CHECK (score_prosperity IS NULL OR (score_prosperity >= 0 AND score_prosperity <= 200)),
  ADD COLUMN IF NOT EXISTS feature_inputs JSONB DEFAULT '{}'::JSONB,
  ADD COLUMN IF NOT EXISTS confidence NUMERIC DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::JSONB,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

COMMENT ON COLUMN public.vitana_index_scores.score_physical IS
  'Physical pillar (0-200). Added 2026-04-23 schema repair.';
COMMENT ON COLUMN public.vitana_index_scores.score_nutritional IS
  'Nutritional pillar (0-200). Added 2026-04-23 schema repair (distinct from legacy score_nutrition).';
COMMENT ON COLUMN public.vitana_index_scores.score_social IS
  'Social pillar (0-200). Added 2026-04-23 schema repair.';
COMMENT ON COLUMN public.vitana_index_scores.score_environmental IS
  'Environmental pillar (0-200). Added 2026-04-23 schema repair.';
COMMENT ON COLUMN public.vitana_index_scores.confidence IS
  'Compute confidence 0.0-1.0. Added 2026-04-23 schema repair.';

COMMIT;
