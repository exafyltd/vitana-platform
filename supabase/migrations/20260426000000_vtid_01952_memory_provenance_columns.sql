-- VTID-01952 — Memory Identity Lock + Provenance Closure (Phase 0)
--
-- Adds provenance columns across the memory-producing surfaces so future writes
-- carry actor / confidence / source-engine / model-version metadata. Without
-- this, low-confidence inferences are indistinguishable from user-stated facts
-- and memory rots silently (Maria→Kemal class of bug).
--
-- All ALTERs use ADD COLUMN IF NOT EXISTS (idempotent + re-runnable).
-- Backfill defaults are intentionally null/conservative — Phase 0 application
-- code populates them on every new write; legacy rows stay nullable until a
-- later backfill job (Phase 4 / consolidator).
--
-- Plan reference: /home/dstev/.claude/plans/the-vitana-system-has-wild-puffin.md
-- Affected categories (per Plan Part 2): Episodic (A), Semantic (B), Social (G)

BEGIN;

-- ============================================================================
-- 1. memory_items (VTID-01104)  —  Episodic stream
--    Distinguish user_stated vs assistant_inferred vs system_observed.
--    Required for retrieval router to weight high-confidence facts higher.
-- ============================================================================

ALTER TABLE public.memory_items
  ADD COLUMN IF NOT EXISTS provenance_source TEXT
    CHECK (provenance_source IS NULL OR provenance_source IN (
      'user_stated',
      'user_stated_via_settings',
      'user_stated_via_memory_garden_ui',
      'user_stated_via_onboarding',
      'user_stated_via_baseline_survey',
      'assistant_inferred',
      'system_observed',
      'consolidator',
      'admin_correction',
      'system_provision'
    )),
  ADD COLUMN IF NOT EXISTS provenance_confidence REAL
    CHECK (provenance_confidence IS NULL OR (provenance_confidence >= 0 AND provenance_confidence <= 1)),
  ADD COLUMN IF NOT EXISTS source_engine TEXT,
  ADD COLUMN IF NOT EXISTS policy_version TEXT;

COMMENT ON COLUMN public.memory_items.provenance_source IS 'How this item entered memory: user_stated, assistant_inferred, system_observed, consolidator, etc. Required for retrieval-router weighting and identity-lock enforcement.';
COMMENT ON COLUMN public.memory_items.provenance_confidence IS '0.0–1.0. user_stated=1.0, assistant_inferred typically 0.4–0.7. NULL on legacy rows (treated as 0.5).';
COMMENT ON COLUMN public.memory_items.source_engine IS 'Which engine produced this row (orb-live, conversation-client, cognee-extractor, autopilot, brain, etc.). Closes the OASIS provenance gap.';
COMMENT ON COLUMN public.memory_items.policy_version IS 'Memory governance policy version at write time (e.g. mem-2026.04). HIPAA audit traceability.';


-- ============================================================================
-- 2. live_rooms.transcript  —  Voice-session transcription quality
--    Bad transcriptions silently feed memory_items today. Add confidence so
--    the brain can downweight low-confidence transcripts and the consolidator
--    can re-extract from corrected transcripts.
-- ============================================================================

ALTER TABLE public.live_rooms
  ADD COLUMN IF NOT EXISTS transcription_confidence REAL
    CHECK (transcription_confidence IS NULL OR (transcription_confidence >= 0 AND transcription_confidence <= 1)),
  ADD COLUMN IF NOT EXISTS transcription_model_version TEXT,
  ADD COLUMN IF NOT EXISTS audio_quality_metrics JSONB;

COMMENT ON COLUMN public.live_rooms.transcription_confidence IS '0.0–1.0 average confidence from transcription model. NULL on legacy rows.';
COMMENT ON COLUMN public.live_rooms.transcription_model_version IS 'e.g. gemini-live-v2, whisper-large-v3. Required to invalidate memory after model upgrade.';
COMMENT ON COLUMN public.live_rooms.audio_quality_metrics IS 'JSON: { snr_db, packet_loss_pct, sample_rate_hz, ... }';


-- ============================================================================
-- 3. user_session_summaries  —  AI-generated session recaps
--    Hallucinated summaries are indistinguishable from real today.
-- ============================================================================

ALTER TABLE public.user_session_summaries
  ADD COLUMN IF NOT EXISTS summary_confidence REAL
    CHECK (summary_confidence IS NULL OR (summary_confidence >= 0 AND summary_confidence <= 1)),
  ADD COLUMN IF NOT EXISTS summary_model_version TEXT,
  ADD COLUMN IF NOT EXISTS summary_method TEXT
    CHECK (summary_method IS NULL OR summary_method IN ('extractive', 'abstractive', 'hybrid'));

COMMENT ON COLUMN public.user_session_summaries.summary_confidence IS '0.0–1.0 confidence in the summary. Low confidence = brain should not echo as fact.';
COMMENT ON COLUMN public.user_session_summaries.summary_model_version IS 'Model + version that produced the summary.';
COMMENT ON COLUMN public.user_session_summaries.summary_method IS 'extractive (verbatim quotes), abstractive (paraphrased), or hybrid.';


-- ============================================================================
-- 4. user_preferences  —  Inferred vs explicit preferences
--    Today no way to distinguish "user explicitly set" from "we guessed".
-- ============================================================================

ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS preference_source TEXT
    CHECK (preference_source IS NULL OR preference_source IN (
      'user_set', 'user_stated_via_settings', 'inferred_from_behavior', 'system_default'
    )),
  ADD COLUMN IF NOT EXISTS preference_confidence REAL
    CHECK (preference_confidence IS NULL OR (preference_confidence >= 0 AND preference_confidence <= 1)),
  ADD COLUMN IF NOT EXISTS inferred_from_sample_size INTEGER
    CHECK (inferred_from_sample_size IS NULL OR inferred_from_sample_size >= 0);

COMMENT ON COLUMN public.user_preferences.preference_source IS 'user_set (explicit UI action), inferred_from_behavior, or system_default. Brain weights user_set highest.';
COMMENT ON COLUMN public.user_preferences.preference_confidence IS '0.0–1.0. user_set=1.0; inferred lower based on sample size.';
COMMENT ON COLUMN public.user_preferences.inferred_from_sample_size IS 'For inferred preferences: how many observations the inference is based on.';


-- ============================================================================
-- 5. community_recommendations  —  Algorithm provenance
--    Today reason field is free text with no engine_version trace.
-- ============================================================================

ALTER TABLE public.community_recommendations
  ADD COLUMN IF NOT EXISTS engine_version TEXT,
  ADD COLUMN IF NOT EXISTS algorithm_type TEXT
    CHECK (algorithm_type IS NULL OR algorithm_type IN (
      'content_based', 'collaborative_filtering', 'rule_based', 'hybrid', 'llm_ranked'
    )),
  ADD COLUMN IF NOT EXISTS confidence_score REAL
    CHECK (confidence_score IS NULL OR (confidence_score >= 0 AND confidence_score <= 1));

COMMENT ON COLUMN public.community_recommendations.engine_version IS 'Which version of the recommendation engine produced this (semver or git-sha).';
COMMENT ON COLUMN public.community_recommendations.algorithm_type IS 'Algorithm class for explainability + tuning.';
COMMENT ON COLUMN public.community_recommendations.confidence_score IS '0.0–1.0 confidence the engine assigned to this recommendation.';


-- ============================================================================
-- 6. thread_summaries  —  Conditionally alter (not all environments have it)
--    Wrapped in DO block because some legacy environments may not have the
--    table yet (it ships as part of VTID-01192 infinite_memory_v2 which is
--    already applied in prod, but defensive idempotency).
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'thread_summaries') THEN
    ALTER TABLE public.thread_summaries
      ADD COLUMN IF NOT EXISTS summary_confidence REAL,
      ADD COLUMN IF NOT EXISTS summary_model_version TEXT,
      ADD COLUMN IF NOT EXISTS summary_method TEXT;
  END IF;
END $$;


-- ============================================================================
-- 7. Backfill policy_version on memory_items for legacy rows
--    Only sets where currently NULL — preserves any value the new application
--    code may have already written.
-- ============================================================================

UPDATE public.memory_items
   SET policy_version = 'mem-2026.04-legacy'
 WHERE policy_version IS NULL;


COMMIT;

-- =====================================================================
-- VERIFICATION (run manually after RUN-MIGRATION.yml dispatch):
--
--   SELECT column_name FROM information_schema.columns
--     WHERE table_schema='public' AND table_name='memory_items'
--       AND column_name IN ('provenance_source','provenance_confidence','source_engine','policy_version');
--   -- Expected: 4 rows.
--
--   SELECT count(*) FILTER (WHERE policy_version IS NOT NULL) AS backfilled,
--          count(*) AS total
--     FROM public.memory_items;
--   -- Expected: backfilled = total
-- =====================================================================
