-- =============================================================================
-- Vitana Index — 5-pillar cleanup (BOOTSTRAP-VITANA-INDEX-5PILLAR)
-- Date: 2026-04-23
-- Plan: .claude/plans/community-user-role-make-purring-pascal.md (Phase E step 2)
--
-- The Vitana Index is built on EXACTLY five pillars: Nutrition, Hydration,
-- Exercise, Sleep, Mental health. The earlier 6-pillar shape
-- (physical/mental/nutritional/social/environmental/prosperity) was drift.
-- This migration erases the drift:
--
--   1. Best-effort maps existing 6-pillar data into the 5-pillar columns
--      so no current user's Index row is nulled out.
--   2. Replaces health_compute_vitana_index() with a minimal 5-pillar
--      version (reads baseline_survey, upserts 5 pillars). Action/data/
--      streak sub-scores + balance factor come in the next step.
--   3. Drops the extraneous columns from vitana_index_scores.
--   4. Cleans vitana_index_config.pillar_weights JSONB (removes 6-pillar
--      keys, ensures 5-pillar keys exist).
--   5. Deletes the 6-pillar system_controls flags.
--   6. NOTIFY pgrst to reload schema cache.
--
-- Idempotent: ADD/DROP COLUMN IF [NOT] EXISTS, CREATE OR REPLACE FUNCTION,
-- DELETE WHERE key IN (...).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Best-effort data mapping BEFORE dropping columns.
-- Only fills 5-pillar values that are NULL/0 from their 6-pillar counterparts.
-- Safe to re-run.
-- -----------------------------------------------------------------------------
UPDATE public.vitana_index_scores
SET
  score_nutrition = COALESCE(NULLIF(score_nutrition, 0), score_nutritional, 100),
  -- score_mental exists in both schemas with the same name; leave as-is.
  -- score_physical was a superset of exercise + sleep. Best-effort: split
  -- evenly when 5-pillar values weren't set.
  score_exercise  = COALESCE(NULLIF(score_exercise,  0), score_physical, 100),
  score_sleep     = COALESCE(NULLIF(score_sleep,     0), CASE WHEN score_physical IS NOT NULL THEN GREATEST(50, score_physical - 30) ELSE 100 END, 100),
  score_hydration = COALESCE(NULLIF(score_hydration, 0), 100)
WHERE
  score_physical IS NOT NULL
  OR score_nutritional IS NOT NULL
  OR score_social IS NOT NULL
  OR score_environmental IS NOT NULL
  OR score_prosperity IS NOT NULL;

-- Also set a minimum floor for any remaining NULL/0 5-pillar values so the
-- user experience doesn't show 0s for data we simply don't have yet.
UPDATE public.vitana_index_scores
SET
  score_nutrition = COALESCE(NULLIF(score_nutrition, 0), 100),
  score_hydration = COALESCE(NULLIF(score_hydration, 0), 100),
  score_exercise  = COALESCE(NULLIF(score_exercise,  0), 100),
  score_sleep     = COALESCE(NULLIF(score_sleep,     0), 100),
  score_mental    = COALESCE(NULLIF(score_mental,    0), 100)
WHERE score_total IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 2. Replace health_compute_vitana_index() with a minimal 5-pillar version.
-- NOTE: must happen BEFORE dropping the 6-pillar columns — the previous
-- function body references them, and a CREATE OR REPLACE will succeed even
-- if the old body would now reference dropped columns (Postgres re-parses
-- the new body, not the old one).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.health_compute_vitana_index(
    p_date DATE,
    p_model_version TEXT DEFAULT 'v3-5pillar-minimal'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_score_nutrition INTEGER := 100;
    v_score_hydration INTEGER := 100;
    v_score_exercise INTEGER := 100;
    v_score_sleep INTEGER := 100;
    v_score_mental INTEGER := 100;
    v_score_total INTEGER := 0;
    v_confidence NUMERIC := 0.3;
    v_weights JSONB;
    v_w_nutrition NUMERIC := 1.0;
    v_w_hydration NUMERIC := 1.0;
    v_w_exercise NUMERIC := 1.0;
    v_w_sleep NUMERIC := 1.0;
    v_w_mental NUMERIC := 1.0;
    v_survey_answers JSONB;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000000'::UUID;
    END IF;

    -- Read baseline survey answers (JSONB). Expected keys: nutrition,
    -- hydration, exercise, sleep, mental — each 1-5 integer. Map to 10/20/25/32/40.
    SELECT answers INTO v_survey_answers
    FROM public.vitana_index_baseline_survey
    WHERE user_id = v_user_id
    LIMIT 1;

    IF v_survey_answers IS NOT NULL THEN
        v_score_nutrition := CASE COALESCE((v_survey_answers->>'nutrition')::INTEGER, 0)
            WHEN 1 THEN 10 WHEN 2 THEN 20 WHEN 3 THEN 25 WHEN 4 THEN 32 WHEN 5 THEN 40 ELSE 10 END;
        v_score_hydration := CASE COALESCE((v_survey_answers->>'hydration')::INTEGER, 0)
            WHEN 1 THEN 10 WHEN 2 THEN 20 WHEN 3 THEN 25 WHEN 4 THEN 32 WHEN 5 THEN 40 ELSE 10 END;
        v_score_exercise := CASE COALESCE((v_survey_answers->>'exercise')::INTEGER, 0)
            WHEN 1 THEN 10 WHEN 2 THEN 20 WHEN 3 THEN 25 WHEN 4 THEN 32 WHEN 5 THEN 40 ELSE 10 END;
        v_score_sleep := CASE COALESCE((v_survey_answers->>'sleep')::INTEGER, 0)
            WHEN 1 THEN 10 WHEN 2 THEN 20 WHEN 3 THEN 25 WHEN 4 THEN 32 WHEN 5 THEN 40 ELSE 10 END;
        v_score_mental := CASE COALESCE((v_survey_answers->>'mental')::INTEGER, 0)
            WHEN 1 THEN 10 WHEN 2 THEN 20 WHEN 3 THEN 25 WHEN 4 THEN 32 WHEN 5 THEN 40 ELSE 10 END;
        v_confidence := 0.5;
    ELSE
        -- No survey → conservative 10s across all five. Wide runway.
        v_score_nutrition := 10;
        v_score_hydration := 10;
        v_score_exercise := 10;
        v_score_sleep := 10;
        v_score_mental := 10;
        v_confidence := 0.1;
    END IF;

    -- Read pillar weights from active config (5-pillar keys).
    SELECT pillar_weights INTO v_weights
    FROM public.vitana_index_config
    WHERE is_active = TRUE
    ORDER BY version DESC
    LIMIT 1;

    IF v_weights IS NOT NULL THEN
        v_w_nutrition := COALESCE((v_weights->>'nutrition')::NUMERIC, 1.0);
        v_w_hydration := COALESCE((v_weights->>'hydration')::NUMERIC, 1.0);
        v_w_exercise  := COALESCE((v_weights->>'exercise')::NUMERIC, 1.0);
        v_w_sleep     := COALESCE((v_weights->>'sleep')::NUMERIC, 1.0);
        v_w_mental    := COALESCE((v_weights->>'mental')::NUMERIC, 1.0);
    END IF;

    v_score_total := LEAST(999, GREATEST(0, ROUND(
          v_score_nutrition * v_w_nutrition
        + v_score_hydration * v_w_hydration
        + v_score_exercise  * v_w_exercise
        + v_score_sleep     * v_w_sleep
        + v_score_mental    * v_w_mental
    )::INTEGER));

    -- Upsert — only 5-pillar columns written.
    INSERT INTO public.vitana_index_scores (
        tenant_id, user_id, date, score_total,
        score_nutrition, score_hydration, score_exercise, score_sleep, score_mental,
        model_version, feature_inputs, confidence
    ) VALUES (
        v_tenant_id, v_user_id, p_date, v_score_total,
        v_score_nutrition, v_score_hydration, v_score_exercise, v_score_sleep, v_score_mental,
        p_model_version,
        jsonb_build_object('source', 'compute_rpc_v3_minimal', 'survey_present', v_survey_answers IS NOT NULL),
        v_confidence
    )
    ON CONFLICT (tenant_id, user_id, date) DO UPDATE SET
        score_total = EXCLUDED.score_total,
        score_nutrition = EXCLUDED.score_nutrition,
        score_hydration = EXCLUDED.score_hydration,
        score_exercise = EXCLUDED.score_exercise,
        score_sleep = EXCLUDED.score_sleep,
        score_mental = EXCLUDED.score_mental,
        model_version = EXCLUDED.model_version,
        feature_inputs = EXCLUDED.feature_inputs,
        confidence = EXCLUDED.confidence,
        updated_at = NOW();

    RETURN jsonb_build_object(
        'ok', true,
        'date', p_date,
        'score_total', v_score_total,
        'score_nutrition', v_score_nutrition,
        'score_hydration', v_score_hydration,
        'score_exercise', v_score_exercise,
        'score_sleep', v_score_sleep,
        'score_mental', v_score_mental,
        'pillar_weights', jsonb_build_object(
            'nutrition', v_w_nutrition,
            'hydration', v_w_hydration,
            'exercise', v_w_exercise,
            'sleep', v_w_sleep,
            'mental', v_w_mental
        ),
        'model_version', p_model_version,
        'confidence', v_confidence
    );
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. Drop the extraneous 6-pillar columns.
-- -----------------------------------------------------------------------------
ALTER TABLE public.vitana_index_scores
  DROP COLUMN IF EXISTS score_physical,
  DROP COLUMN IF EXISTS score_social,
  DROP COLUMN IF EXISTS score_environmental,
  DROP COLUMN IF EXISTS score_prosperity,
  DROP COLUMN IF EXISTS score_nutritional;

-- -----------------------------------------------------------------------------
-- 4. Clean vitana_index_config.pillar_weights — keep only 5 canonical keys.
-- -----------------------------------------------------------------------------
UPDATE public.vitana_index_config
SET pillar_weights = jsonb_build_object(
  'nutrition', COALESCE((pillar_weights->>'nutrition')::NUMERIC, (pillar_weights->>'nutritional')::NUMERIC, 1.0),
  'hydration', COALESCE((pillar_weights->>'hydration')::NUMERIC, 1.0),
  'exercise',  COALESCE((pillar_weights->>'exercise')::NUMERIC,  (pillar_weights->>'physical')::NUMERIC, 1.0),
  'sleep',     COALESCE((pillar_weights->>'sleep')::NUMERIC, 1.0),
  'mental',    COALESCE((pillar_weights->>'mental')::NUMERIC, 1.0)
)
WHERE pillar_weights IS NOT NULL;

COMMENT ON COLUMN public.vitana_index_config.pillar_weights IS
  'Per-pillar multiplier applied by health_compute_vitana_index(). Keys: nutrition, hydration, exercise, sleep, mental. Default 1.0 each.';

-- -----------------------------------------------------------------------------
-- 5. Drop 6-pillar system_controls flags.
-- -----------------------------------------------------------------------------
DELETE FROM public.system_controls
WHERE key IN (
  'index_prosperity_pillar_enabled',
  'index_social_pillar_enabled',
  'index_environmental_pillar_enabled'
);

-- -----------------------------------------------------------------------------
-- 6. Reload PostgREST schema cache so the dropped columns disappear from
--    the REST API and the new RPC signature is visible.
-- -----------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';

COMMIT;
