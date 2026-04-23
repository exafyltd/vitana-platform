-- =============================================================================
-- Vitana Index — v3 full compute RPC (BOOTSTRAP-VITANA-INDEX-V3)
-- Date: 2026-04-23
-- Plan: .claude/plans/community-user-role-make-purring-pascal.md (step 3)
--
-- Replaces the minimal v3 RPC from step 2 with the full model:
--   pillar_score = baseline_survey + action_completions + connected_data
--                  + streak_bonus                                   (max 200)
--   raw_sum       = Σ pillar_i × weight_i
--   ratio         = min_pillar / max_pillar
--   balance_factor= 1.0 / 0.9 / 0.8 / 0.7  based on ratio bands
--   score_total   = min(999, round(raw_sum × balance_factor))
--
-- Per-pillar components:
--   baseline_survey  (max 40)  — ratings 1-5 → 10/20/25/32/40
--   action_completions (max 80) — calendar_events.completion_status='completed'
--                                 in last 30 days, tagged for this pillar,
--                                 each completion +6, capped at 80
--   connected_data   (max 40)  — recent health_features_daily rows for
--                                 pillar-relevant feature keys
--   streak_bonus     (max 40)  — consecutive days with a completion OR data
--                                 signal for this pillar:
--                                 7d → +15, 14d → +25, 30d → +40
--
-- Tag → pillar map (wellness_tags on calendar_events):
--   nutrition : nutrition, meal, food-log
--   hydration : hydration, water
--   exercise  : movement, workout, walk, steps, exercise
--   sleep     : sleep, rest, recovery
--   mental    : mindfulness, mental, stress, meditation, learning, journal
--   (unmapped tags e.g. onboarding/social/community/health-check add a
--   small +1 "halo" to every pillar — community actions are gently
--   good-for-everything)
--
-- Idempotent: CREATE OR REPLACE FUNCTION.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Helper: vitana_pillar_streak_days(user_id, pillar_key)
-- Returns the number of consecutive days ending today that have at least one
-- completion OR data signal for the given pillar. Max 90 days lookback.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.vitana_pillar_streak_days(
    p_user_id UUID,
    p_pillar_key TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tags TEXT[];
    v_features TEXT[];
    v_streak INTEGER := 0;
    v_day DATE := CURRENT_DATE;
    v_signal BOOLEAN;
BEGIN
    -- Map pillar → calendar tags
    v_tags := CASE p_pillar_key
        WHEN 'nutrition' THEN ARRAY['nutrition','meal','food-log']
        WHEN 'hydration' THEN ARRAY['hydration','water']
        WHEN 'exercise'  THEN ARRAY['movement','workout','walk','steps','exercise']
        WHEN 'sleep'     THEN ARRAY['sleep','rest','recovery']
        WHEN 'mental'    THEN ARRAY['mindfulness','mental','stress','meditation','learning','journal']
        ELSE ARRAY[]::TEXT[]
    END;

    -- Map pillar → feature keys (health_features_daily.feature_key)
    v_features := CASE p_pillar_key
        WHEN 'nutrition' THEN ARRAY['biomarker_glucose','biomarker_hba1c','meal_log','macro_balance']
        WHEN 'hydration' THEN ARRAY['water_intake','hydration_log']
        WHEN 'exercise'  THEN ARRAY['wearable_heart_rate','wearable_steps','wearable_workout','vo2_max']
        WHEN 'sleep'     THEN ARRAY['wearable_sleep_duration','wearable_sleep_efficiency','wearable_hrv','wearable_sleep_stages']
        WHEN 'mental'    THEN ARRAY['wearable_stress','mood_entry','meditation_minutes','journal_entry']
        ELSE ARRAY[]::TEXT[]
    END;

    -- Walk back day by day; break on first gap
    FOR i IN 0..89 LOOP
        v_day := CURRENT_DATE - i;

        -- Any completed calendar event on v_day tagged for this pillar?
        v_signal := EXISTS (
            SELECT 1 FROM public.calendar_events
            WHERE user_id = p_user_id
              AND completion_status = 'completed'
              AND DATE(COALESCE(completed_at, end_time)) = v_day
              AND wellness_tags && v_tags
        );

        -- Or any pillar-relevant feature row for v_day?
        IF NOT v_signal THEN
            v_signal := EXISTS (
                SELECT 1 FROM public.health_features_daily
                WHERE user_id = p_user_id
                  AND date = v_day
                  AND feature_key = ANY(v_features)
            );
        END IF;

        IF v_signal THEN
            v_streak := v_streak + 1;
        ELSE
            EXIT;
        END IF;
    END LOOP;

    RETURN v_streak;
END;
$$;

COMMENT ON FUNCTION public.vitana_pillar_streak_days(UUID, TEXT) IS
  'Consecutive days (ending today, up to 90) with at least one completion or data signal for the given pillar. Used by health_compute_vitana_index() v3 streak_bonus sub-score.';

-- -----------------------------------------------------------------------------
-- Main: health_compute_vitana_index() v3 — full 4-component + balance factor.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.health_compute_vitana_index(
    p_date DATE,
    p_model_version TEXT DEFAULT 'v3-5pillar'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;

    -- Baseline sub-scores (from survey answers JSONB)
    v_b_nutrition INTEGER := 10;
    v_b_hydration INTEGER := 10;
    v_b_exercise INTEGER := 10;
    v_b_sleep INTEGER := 10;
    v_b_mental INTEGER := 10;

    -- Action completions sub-scores (last 30 days)
    v_ac_nutrition INTEGER := 0;
    v_ac_hydration INTEGER := 0;
    v_ac_exercise INTEGER := 0;
    v_ac_sleep INTEGER := 0;
    v_ac_mental INTEGER := 0;

    -- Connected data sub-scores (last 7 days)
    v_cd_nutrition INTEGER := 0;
    v_cd_hydration INTEGER := 0;
    v_cd_exercise INTEGER := 0;
    v_cd_sleep INTEGER := 0;
    v_cd_mental INTEGER := 0;

    -- Streak bonus sub-scores
    v_sb_nutrition INTEGER := 0;
    v_sb_hydration INTEGER := 0;
    v_sb_exercise INTEGER := 0;
    v_sb_sleep INTEGER := 0;
    v_sb_mental INTEGER := 0;

    -- Totals per pillar (capped 0..200)
    v_score_nutrition INTEGER;
    v_score_hydration INTEGER;
    v_score_exercise INTEGER;
    v_score_sleep INTEGER;
    v_score_mental INTEGER;

    -- Balance + totals
    v_raw_sum NUMERIC;
    v_min_pillar INTEGER;
    v_max_pillar INTEGER;
    v_ratio NUMERIC;
    v_balance_factor NUMERIC;
    v_score_total INTEGER;

    -- Weights
    v_weights JSONB;
    v_w_nutrition NUMERIC := 1.0;
    v_w_hydration NUMERIC := 1.0;
    v_w_exercise NUMERIC := 1.0;
    v_w_sleep NUMERIC := 1.0;
    v_w_mental NUMERIC := 1.0;

    v_confidence NUMERIC := 0.3;
    v_survey_answers JSONB;

    -- For action completion counting
    v_ev RECORD;
    v_tag TEXT;
    v_nutrition_tags TEXT[] := ARRAY['nutrition','meal','food-log'];
    v_hydration_tags TEXT[] := ARRAY['hydration','water'];
    v_exercise_tags  TEXT[] := ARRAY['movement','workout','walk','steps','exercise'];
    v_sleep_tags     TEXT[] := ARRAY['sleep','rest','recovery'];
    v_mental_tags    TEXT[] := ARRAY['mindfulness','mental','stress','meditation','learning','journal'];

    v_streak INTEGER;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000000'::UUID;
    END IF;

    -- -------------------------------------------------------------------------
    -- 1. Baseline survey sub-scores (max 40 per pillar)
    -- -------------------------------------------------------------------------
    SELECT answers INTO v_survey_answers
    FROM public.vitana_index_baseline_survey
    WHERE user_id = v_user_id
    LIMIT 1;

    IF v_survey_answers IS NOT NULL THEN
        v_b_nutrition := CASE COALESCE((v_survey_answers->>'nutrition')::INTEGER, 0)
            WHEN 1 THEN 10 WHEN 2 THEN 20 WHEN 3 THEN 25 WHEN 4 THEN 32 WHEN 5 THEN 40 ELSE 10 END;
        v_b_hydration := CASE COALESCE((v_survey_answers->>'hydration')::INTEGER, 0)
            WHEN 1 THEN 10 WHEN 2 THEN 20 WHEN 3 THEN 25 WHEN 4 THEN 32 WHEN 5 THEN 40 ELSE 10 END;
        v_b_exercise := CASE COALESCE((v_survey_answers->>'exercise')::INTEGER, 0)
            WHEN 1 THEN 10 WHEN 2 THEN 20 WHEN 3 THEN 25 WHEN 4 THEN 32 WHEN 5 THEN 40 ELSE 10 END;
        v_b_sleep := CASE COALESCE((v_survey_answers->>'sleep')::INTEGER, 0)
            WHEN 1 THEN 10 WHEN 2 THEN 20 WHEN 3 THEN 25 WHEN 4 THEN 32 WHEN 5 THEN 40 ELSE 10 END;
        v_b_mental := CASE COALESCE((v_survey_answers->>'mental')::INTEGER, 0)
            WHEN 1 THEN 10 WHEN 2 THEN 20 WHEN 3 THEN 25 WHEN 4 THEN 32 WHEN 5 THEN 40 ELSE 10 END;
        v_confidence := 0.5;
    END IF;

    -- -------------------------------------------------------------------------
    -- 2. Action completions sub-scores (last 30 days, max 80 per pillar)
    --    Each completion whose wellness_tags match the pillar's tag bucket
    --    adds 6 points. "Halo" tags (none matching) add +1 to every pillar.
    -- -------------------------------------------------------------------------
    FOR v_ev IN
        SELECT wellness_tags
        FROM public.calendar_events
        WHERE user_id = v_user_id
          AND completion_status = 'completed'
          AND COALESCE(completed_at, end_time) >= (CURRENT_DATE - INTERVAL '30 days')
    LOOP
        IF v_ev.wellness_tags && v_nutrition_tags THEN v_ac_nutrition := v_ac_nutrition + 6; END IF;
        IF v_ev.wellness_tags && v_hydration_tags THEN v_ac_hydration := v_ac_hydration + 6; END IF;
        IF v_ev.wellness_tags && v_exercise_tags  THEN v_ac_exercise  := v_ac_exercise  + 6; END IF;
        IF v_ev.wellness_tags && v_sleep_tags     THEN v_ac_sleep     := v_ac_sleep     + 6; END IF;
        IF v_ev.wellness_tags && v_mental_tags    THEN v_ac_mental    := v_ac_mental    + 6; END IF;

        -- Halo: if the event's tags don't hit any pillar bucket, add +1 to all.
        IF NOT (v_ev.wellness_tags && v_nutrition_tags
             OR v_ev.wellness_tags && v_hydration_tags
             OR v_ev.wellness_tags && v_exercise_tags
             OR v_ev.wellness_tags && v_sleep_tags
             OR v_ev.wellness_tags && v_mental_tags)
        THEN
            v_ac_nutrition := v_ac_nutrition + 1;
            v_ac_hydration := v_ac_hydration + 1;
            v_ac_exercise  := v_ac_exercise  + 1;
            v_ac_sleep     := v_ac_sleep     + 1;
            v_ac_mental    := v_ac_mental    + 1;
        END IF;
    END LOOP;

    -- Cap each at 80
    v_ac_nutrition := LEAST(v_ac_nutrition, 80);
    v_ac_hydration := LEAST(v_ac_hydration, 80);
    v_ac_exercise  := LEAST(v_ac_exercise,  80);
    v_ac_sleep     := LEAST(v_ac_sleep,     80);
    v_ac_mental    := LEAST(v_ac_mental,    80);

    -- -------------------------------------------------------------------------
    -- 3. Connected data sub-scores (last 7 days, max 40 per pillar)
    --    Score is driven by pillar-relevant feature_key presence + count.
    --    0 rows → 0, 1-3 rows → 15, 4-10 rows → 25, 11+ rows → 40.
    -- -------------------------------------------------------------------------
    SELECT CASE WHEN COUNT(*) >= 11 THEN 40 WHEN COUNT(*) >= 4 THEN 25 WHEN COUNT(*) >= 1 THEN 15 ELSE 0 END
    INTO v_cd_nutrition
    FROM public.health_features_daily
    WHERE user_id = v_user_id
      AND date >= (CURRENT_DATE - INTERVAL '7 days')
      AND feature_key = ANY(ARRAY['biomarker_glucose','biomarker_hba1c','meal_log','macro_balance']);

    SELECT CASE WHEN COUNT(*) >= 11 THEN 40 WHEN COUNT(*) >= 4 THEN 25 WHEN COUNT(*) >= 1 THEN 15 ELSE 0 END
    INTO v_cd_hydration
    FROM public.health_features_daily
    WHERE user_id = v_user_id
      AND date >= (CURRENT_DATE - INTERVAL '7 days')
      AND feature_key = ANY(ARRAY['water_intake','hydration_log']);

    SELECT CASE WHEN COUNT(*) >= 11 THEN 40 WHEN COUNT(*) >= 4 THEN 25 WHEN COUNT(*) >= 1 THEN 15 ELSE 0 END
    INTO v_cd_exercise
    FROM public.health_features_daily
    WHERE user_id = v_user_id
      AND date >= (CURRENT_DATE - INTERVAL '7 days')
      AND feature_key = ANY(ARRAY['wearable_heart_rate','wearable_steps','wearable_workout','vo2_max']);

    SELECT CASE WHEN COUNT(*) >= 11 THEN 40 WHEN COUNT(*) >= 4 THEN 25 WHEN COUNT(*) >= 1 THEN 15 ELSE 0 END
    INTO v_cd_sleep
    FROM public.health_features_daily
    WHERE user_id = v_user_id
      AND date >= (CURRENT_DATE - INTERVAL '7 days')
      AND feature_key = ANY(ARRAY['wearable_sleep_duration','wearable_sleep_efficiency','wearable_hrv','wearable_sleep_stages']);

    SELECT CASE WHEN COUNT(*) >= 11 THEN 40 WHEN COUNT(*) >= 4 THEN 25 WHEN COUNT(*) >= 1 THEN 15 ELSE 0 END
    INTO v_cd_mental
    FROM public.health_features_daily
    WHERE user_id = v_user_id
      AND date >= (CURRENT_DATE - INTERVAL '7 days')
      AND feature_key = ANY(ARRAY['wearable_stress','mood_entry','meditation_minutes','journal_entry']);

    -- -------------------------------------------------------------------------
    -- 4. Streak bonuses (max 40 per pillar)
    -- -------------------------------------------------------------------------
    v_streak := public.vitana_pillar_streak_days(v_user_id, 'nutrition');
    v_sb_nutrition := CASE WHEN v_streak >= 30 THEN 40 WHEN v_streak >= 14 THEN 25 WHEN v_streak >= 7 THEN 15 ELSE 0 END;

    v_streak := public.vitana_pillar_streak_days(v_user_id, 'hydration');
    v_sb_hydration := CASE WHEN v_streak >= 30 THEN 40 WHEN v_streak >= 14 THEN 25 WHEN v_streak >= 7 THEN 15 ELSE 0 END;

    v_streak := public.vitana_pillar_streak_days(v_user_id, 'exercise');
    v_sb_exercise := CASE WHEN v_streak >= 30 THEN 40 WHEN v_streak >= 14 THEN 25 WHEN v_streak >= 7 THEN 15 ELSE 0 END;

    v_streak := public.vitana_pillar_streak_days(v_user_id, 'sleep');
    v_sb_sleep := CASE WHEN v_streak >= 30 THEN 40 WHEN v_streak >= 14 THEN 25 WHEN v_streak >= 7 THEN 15 ELSE 0 END;

    v_streak := public.vitana_pillar_streak_days(v_user_id, 'mental');
    v_sb_mental := CASE WHEN v_streak >= 30 THEN 40 WHEN v_streak >= 14 THEN 25 WHEN v_streak >= 7 THEN 15 ELSE 0 END;

    -- -------------------------------------------------------------------------
    -- 5. Sum sub-scores per pillar, cap at 200.
    -- -------------------------------------------------------------------------
    v_score_nutrition := LEAST(200, v_b_nutrition + v_ac_nutrition + v_cd_nutrition + v_sb_nutrition);
    v_score_hydration := LEAST(200, v_b_hydration + v_ac_hydration + v_cd_hydration + v_sb_hydration);
    v_score_exercise  := LEAST(200, v_b_exercise  + v_ac_exercise  + v_cd_exercise  + v_sb_exercise);
    v_score_sleep     := LEAST(200, v_b_sleep     + v_ac_sleep     + v_cd_sleep     + v_sb_sleep);
    v_score_mental    := LEAST(200, v_b_mental    + v_ac_mental    + v_cd_mental    + v_sb_mental);

    -- -------------------------------------------------------------------------
    -- 6. Weights from active config (default 1.0 each).
    -- -------------------------------------------------------------------------
    SELECT pillar_weights INTO v_weights
    FROM public.vitana_index_config
    WHERE is_active = TRUE
    ORDER BY version DESC
    LIMIT 1;

    IF v_weights IS NOT NULL THEN
        v_w_nutrition := COALESCE((v_weights->>'nutrition')::NUMERIC, 1.0);
        v_w_hydration := COALESCE((v_weights->>'hydration')::NUMERIC, 1.0);
        v_w_exercise  := COALESCE((v_weights->>'exercise')::NUMERIC,  1.0);
        v_w_sleep     := COALESCE((v_weights->>'sleep')::NUMERIC,     1.0);
        v_w_mental    := COALESCE((v_weights->>'mental')::NUMERIC,    1.0);
    END IF;

    -- -------------------------------------------------------------------------
    -- 7. Raw sum + balance factor + final total.
    -- -------------------------------------------------------------------------
    v_raw_sum :=
          v_score_nutrition * v_w_nutrition
        + v_score_hydration * v_w_hydration
        + v_score_exercise  * v_w_exercise
        + v_score_sleep     * v_w_sleep
        + v_score_mental    * v_w_mental;

    v_min_pillar := LEAST(v_score_nutrition, v_score_hydration, v_score_exercise, v_score_sleep, v_score_mental);
    v_max_pillar := GREATEST(v_score_nutrition, v_score_hydration, v_score_exercise, v_score_sleep, v_score_mental);

    IF v_max_pillar > 0 THEN
        v_ratio := v_min_pillar::NUMERIC / v_max_pillar::NUMERIC;
    ELSE
        v_ratio := 1.0;
    END IF;

    v_balance_factor := CASE
        WHEN v_ratio >= 0.70 THEN 1.00
        WHEN v_ratio >= 0.50 THEN 0.90
        WHEN v_ratio >= 0.30 THEN 0.80
        ELSE 0.70
    END;

    v_score_total := LEAST(999, GREATEST(0, ROUND(v_raw_sum * v_balance_factor)::INTEGER));

    -- Confidence: base confidence + bumps for real signal sources
    IF v_ac_nutrition + v_ac_hydration + v_ac_exercise + v_ac_sleep + v_ac_mental > 0 THEN
        v_confidence := GREATEST(v_confidence, 0.7);
    END IF;
    IF v_cd_nutrition + v_cd_hydration + v_cd_exercise + v_cd_sleep + v_cd_mental > 0 THEN
        v_confidence := GREATEST(v_confidence, 0.85);
    END IF;

    -- -------------------------------------------------------------------------
    -- 8. Upsert + return with full sub-score breakdown in feature_inputs.
    -- -------------------------------------------------------------------------
    INSERT INTO public.vitana_index_scores (
        tenant_id, user_id, date, score_total,
        score_nutrition, score_hydration, score_exercise, score_sleep, score_mental,
        model_version, feature_inputs, confidence
    ) VALUES (
        v_tenant_id, v_user_id, p_date, v_score_total,
        v_score_nutrition, v_score_hydration, v_score_exercise, v_score_sleep, v_score_mental,
        p_model_version,
        jsonb_build_object(
            'source', 'compute_rpc_v3',
            'balance_factor', v_balance_factor,
            'ratio', v_ratio,
            'raw_sum', v_raw_sum,
            'subscores', jsonb_build_object(
                'nutrition', jsonb_build_object('baseline', v_b_nutrition, 'completions', v_ac_nutrition, 'data', v_cd_nutrition, 'streak', v_sb_nutrition),
                'hydration', jsonb_build_object('baseline', v_b_hydration, 'completions', v_ac_hydration, 'data', v_cd_hydration, 'streak', v_sb_hydration),
                'exercise',  jsonb_build_object('baseline', v_b_exercise,  'completions', v_ac_exercise,  'data', v_cd_exercise,  'streak', v_sb_exercise),
                'sleep',     jsonb_build_object('baseline', v_b_sleep,     'completions', v_ac_sleep,     'data', v_cd_sleep,     'streak', v_sb_sleep),
                'mental',    jsonb_build_object('baseline', v_b_mental,    'completions', v_ac_mental,    'data', v_cd_mental,    'streak', v_sb_mental)
            )
        ),
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
        'raw_sum', v_raw_sum,
        'balance_factor', v_balance_factor,
        'ratio', v_ratio,
        'subscores', jsonb_build_object(
            'nutrition', jsonb_build_object('baseline', v_b_nutrition, 'completions', v_ac_nutrition, 'data', v_cd_nutrition, 'streak', v_sb_nutrition),
            'hydration', jsonb_build_object('baseline', v_b_hydration, 'completions', v_ac_hydration, 'data', v_cd_hydration, 'streak', v_sb_hydration),
            'exercise',  jsonb_build_object('baseline', v_b_exercise,  'completions', v_ac_exercise,  'data', v_cd_exercise,  'streak', v_sb_exercise),
            'sleep',     jsonb_build_object('baseline', v_b_sleep,     'completions', v_ac_sleep,     'data', v_cd_sleep,     'streak', v_sb_sleep),
            'mental',    jsonb_build_object('baseline', v_b_mental,    'completions', v_ac_mental,    'data', v_cd_mental,    'streak', v_sb_mental)
        ),
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

COMMENT ON FUNCTION public.health_compute_vitana_index(DATE, TEXT) IS
  'Vitana Index v3 compute: 5 pillars × 4 sub-scores (baseline / action_completions / connected_data / streak_bonus) × pillar_weights, with balance_factor dampening when pillars are lopsided. Writes vitana_index_scores row for the given date.';

NOTIFY pgrst, 'reload schema';

COMMIT;
