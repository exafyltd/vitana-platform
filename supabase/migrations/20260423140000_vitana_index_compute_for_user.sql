-- =============================================================================
-- Vitana Index — health_compute_vitana_index_for_user (BOOTSTRAP-VITANA-INDEX-FOR-USER)
-- Date: 2026-04-23
--
-- Admin-callable sibling of health_compute_vitana_index() that accepts the
-- user_id explicitly instead of reading auth.uid(). Needed so server-side
-- code (e.g., the calendar completion loop) can trigger a recompute for a
-- specific user without having to pass a user JWT.
--
-- Shares the same compute body as the main RPC (copy of v3). Kept in sync
-- manually; we'll factor into a shared plpgsql function in a follow-up if
-- divergence becomes a problem.
--
-- GRANT: service_role only. Anon + authenticated callers cannot invoke it.
-- Idempotent: CREATE OR REPLACE FUNCTION + explicit GRANT/REVOKE.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.health_compute_vitana_index_for_user(
    p_user_id UUID,
    p_date DATE,
    p_model_version TEXT DEFAULT 'v3-5pillar'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;

    v_b_nutrition INTEGER := 10;
    v_b_hydration INTEGER := 10;
    v_b_exercise INTEGER := 10;
    v_b_sleep INTEGER := 10;
    v_b_mental INTEGER := 10;

    v_ac_nutrition INTEGER := 0;
    v_ac_hydration INTEGER := 0;
    v_ac_exercise INTEGER := 0;
    v_ac_sleep INTEGER := 0;
    v_ac_mental INTEGER := 0;

    v_cd_nutrition INTEGER := 0;
    v_cd_hydration INTEGER := 0;
    v_cd_exercise INTEGER := 0;
    v_cd_sleep INTEGER := 0;
    v_cd_mental INTEGER := 0;

    v_sb_nutrition INTEGER := 0;
    v_sb_hydration INTEGER := 0;
    v_sb_exercise INTEGER := 0;
    v_sb_sleep INTEGER := 0;
    v_sb_mental INTEGER := 0;

    v_score_nutrition INTEGER;
    v_score_hydration INTEGER;
    v_score_exercise INTEGER;
    v_score_sleep INTEGER;
    v_score_mental INTEGER;

    v_raw_sum NUMERIC;
    v_min_pillar INTEGER;
    v_max_pillar INTEGER;
    v_ratio NUMERIC;
    v_balance_factor NUMERIC;
    v_score_total INTEGER;

    v_weights JSONB;
    v_w_nutrition NUMERIC := 1.0;
    v_w_hydration NUMERIC := 1.0;
    v_w_exercise NUMERIC := 1.0;
    v_w_sleep NUMERIC := 1.0;
    v_w_mental NUMERIC := 1.0;

    v_confidence NUMERIC := 0.3;
    v_survey_answers JSONB;
    v_ev RECORD;

    v_nutrition_tags TEXT[] := ARRAY['nutrition','meal','food-log'];
    v_hydration_tags TEXT[] := ARRAY['hydration','water'];
    v_exercise_tags  TEXT[] := ARRAY['movement','workout','walk','steps','exercise'];
    v_sleep_tags     TEXT[] := ARRAY['sleep','rest','recovery'];
    v_mental_tags    TEXT[] := ARRAY['mindfulness','mental','stress','meditation','learning','journal'];

    v_streak INTEGER;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'USER_ID_REQUIRED');
    END IF;

    -- Tenant resolution: use user_tenants lookup; fall back to zero-UUID.
    SELECT tenant_id INTO v_tenant_id
    FROM public.user_tenants
    WHERE user_id = p_user_id
    LIMIT 1;
    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000000'::UUID;
    END IF;

    -- Baseline
    SELECT answers INTO v_survey_answers
    FROM public.vitana_index_baseline_survey
    WHERE user_id = p_user_id LIMIT 1;

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

    -- Action completions
    FOR v_ev IN
        SELECT wellness_tags
        FROM public.calendar_events
        WHERE user_id = p_user_id
          AND completion_status = 'completed'
          AND COALESCE(completed_at, end_time) >= (CURRENT_DATE - INTERVAL '30 days')
    LOOP
        IF v_ev.wellness_tags && v_nutrition_tags THEN v_ac_nutrition := v_ac_nutrition + 6; END IF;
        IF v_ev.wellness_tags && v_hydration_tags THEN v_ac_hydration := v_ac_hydration + 6; END IF;
        IF v_ev.wellness_tags && v_exercise_tags  THEN v_ac_exercise  := v_ac_exercise  + 6; END IF;
        IF v_ev.wellness_tags && v_sleep_tags     THEN v_ac_sleep     := v_ac_sleep     + 6; END IF;
        IF v_ev.wellness_tags && v_mental_tags    THEN v_ac_mental    := v_ac_mental    + 6; END IF;
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
    v_ac_nutrition := LEAST(v_ac_nutrition, 80);
    v_ac_hydration := LEAST(v_ac_hydration, 80);
    v_ac_exercise  := LEAST(v_ac_exercise,  80);
    v_ac_sleep     := LEAST(v_ac_sleep,     80);
    v_ac_mental    := LEAST(v_ac_mental,    80);

    -- Connected data
    SELECT CASE WHEN COUNT(*) >= 11 THEN 40 WHEN COUNT(*) >= 4 THEN 25 WHEN COUNT(*) >= 1 THEN 15 ELSE 0 END
    INTO v_cd_nutrition
    FROM public.health_features_daily
    WHERE user_id = p_user_id AND date >= (CURRENT_DATE - INTERVAL '7 days')
      AND feature_key = ANY(ARRAY['biomarker_glucose','biomarker_hba1c','meal_log','macro_balance']);

    SELECT CASE WHEN COUNT(*) >= 11 THEN 40 WHEN COUNT(*) >= 4 THEN 25 WHEN COUNT(*) >= 1 THEN 15 ELSE 0 END
    INTO v_cd_hydration
    FROM public.health_features_daily
    WHERE user_id = p_user_id AND date >= (CURRENT_DATE - INTERVAL '7 days')
      AND feature_key = ANY(ARRAY['water_intake','hydration_log']);

    SELECT CASE WHEN COUNT(*) >= 11 THEN 40 WHEN COUNT(*) >= 4 THEN 25 WHEN COUNT(*) >= 1 THEN 15 ELSE 0 END
    INTO v_cd_exercise
    FROM public.health_features_daily
    WHERE user_id = p_user_id AND date >= (CURRENT_DATE - INTERVAL '7 days')
      AND feature_key = ANY(ARRAY['wearable_heart_rate','wearable_steps','wearable_workout','vo2_max']);

    SELECT CASE WHEN COUNT(*) >= 11 THEN 40 WHEN COUNT(*) >= 4 THEN 25 WHEN COUNT(*) >= 1 THEN 15 ELSE 0 END
    INTO v_cd_sleep
    FROM public.health_features_daily
    WHERE user_id = p_user_id AND date >= (CURRENT_DATE - INTERVAL '7 days')
      AND feature_key = ANY(ARRAY['wearable_sleep_duration','wearable_sleep_efficiency','wearable_hrv','wearable_sleep_stages']);

    SELECT CASE WHEN COUNT(*) >= 11 THEN 40 WHEN COUNT(*) >= 4 THEN 25 WHEN COUNT(*) >= 1 THEN 15 ELSE 0 END
    INTO v_cd_mental
    FROM public.health_features_daily
    WHERE user_id = p_user_id AND date >= (CURRENT_DATE - INTERVAL '7 days')
      AND feature_key = ANY(ARRAY['wearable_stress','mood_entry','meditation_minutes','journal_entry']);

    -- Streak bonuses — reuses the existing helper.
    v_streak := public.vitana_pillar_streak_days(p_user_id, 'nutrition');
    v_sb_nutrition := CASE WHEN v_streak >= 30 THEN 40 WHEN v_streak >= 14 THEN 25 WHEN v_streak >= 7 THEN 15 ELSE 0 END;
    v_streak := public.vitana_pillar_streak_days(p_user_id, 'hydration');
    v_sb_hydration := CASE WHEN v_streak >= 30 THEN 40 WHEN v_streak >= 14 THEN 25 WHEN v_streak >= 7 THEN 15 ELSE 0 END;
    v_streak := public.vitana_pillar_streak_days(p_user_id, 'exercise');
    v_sb_exercise := CASE WHEN v_streak >= 30 THEN 40 WHEN v_streak >= 14 THEN 25 WHEN v_streak >= 7 THEN 15 ELSE 0 END;
    v_streak := public.vitana_pillar_streak_days(p_user_id, 'sleep');
    v_sb_sleep := CASE WHEN v_streak >= 30 THEN 40 WHEN v_streak >= 14 THEN 25 WHEN v_streak >= 7 THEN 15 ELSE 0 END;
    v_streak := public.vitana_pillar_streak_days(p_user_id, 'mental');
    v_sb_mental := CASE WHEN v_streak >= 30 THEN 40 WHEN v_streak >= 14 THEN 25 WHEN v_streak >= 7 THEN 15 ELSE 0 END;

    -- Pillar totals + cap
    v_score_nutrition := LEAST(200, v_b_nutrition + v_ac_nutrition + v_cd_nutrition + v_sb_nutrition);
    v_score_hydration := LEAST(200, v_b_hydration + v_ac_hydration + v_cd_hydration + v_sb_hydration);
    v_score_exercise  := LEAST(200, v_b_exercise  + v_ac_exercise  + v_cd_exercise  + v_sb_exercise);
    v_score_sleep     := LEAST(200, v_b_sleep     + v_ac_sleep     + v_cd_sleep     + v_sb_sleep);
    v_score_mental    := LEAST(200, v_b_mental    + v_ac_mental    + v_cd_mental    + v_sb_mental);

    -- Weights
    SELECT pillar_weights INTO v_weights
    FROM public.vitana_index_config
    WHERE is_active = TRUE ORDER BY version DESC LIMIT 1;
    IF v_weights IS NOT NULL THEN
        v_w_nutrition := COALESCE((v_weights->>'nutrition')::NUMERIC, 1.0);
        v_w_hydration := COALESCE((v_weights->>'hydration')::NUMERIC, 1.0);
        v_w_exercise  := COALESCE((v_weights->>'exercise')::NUMERIC,  1.0);
        v_w_sleep     := COALESCE((v_weights->>'sleep')::NUMERIC,     1.0);
        v_w_mental    := COALESCE((v_weights->>'mental')::NUMERIC,    1.0);
    END IF;

    v_raw_sum :=
          v_score_nutrition * v_w_nutrition
        + v_score_hydration * v_w_hydration
        + v_score_exercise  * v_w_exercise
        + v_score_sleep     * v_w_sleep
        + v_score_mental    * v_w_mental;

    v_min_pillar := LEAST(v_score_nutrition, v_score_hydration, v_score_exercise, v_score_sleep, v_score_mental);
    v_max_pillar := GREATEST(v_score_nutrition, v_score_hydration, v_score_exercise, v_score_sleep, v_score_mental);
    IF v_max_pillar > 0 THEN v_ratio := v_min_pillar::NUMERIC / v_max_pillar::NUMERIC; ELSE v_ratio := 1.0; END IF;
    v_balance_factor := CASE
        WHEN v_ratio >= 0.70 THEN 1.00
        WHEN v_ratio >= 0.50 THEN 0.90
        WHEN v_ratio >= 0.30 THEN 0.80
        ELSE 0.70
    END;
    v_score_total := LEAST(999, GREATEST(0, ROUND(v_raw_sum * v_balance_factor)::INTEGER));

    IF v_ac_nutrition + v_ac_hydration + v_ac_exercise + v_ac_sleep + v_ac_mental > 0 THEN
        v_confidence := GREATEST(v_confidence, 0.7);
    END IF;
    IF v_cd_nutrition + v_cd_hydration + v_cd_exercise + v_cd_sleep + v_cd_mental > 0 THEN
        v_confidence := GREATEST(v_confidence, 0.85);
    END IF;

    -- Upsert
    INSERT INTO public.vitana_index_scores (
        tenant_id, user_id, date, score_total,
        score_nutrition, score_hydration, score_exercise, score_sleep, score_mental,
        model_version, feature_inputs, confidence
    ) VALUES (
        v_tenant_id, p_user_id, p_date, v_score_total,
        v_score_nutrition, v_score_hydration, v_score_exercise, v_score_sleep, v_score_mental,
        p_model_version,
        jsonb_build_object(
            'source', 'compute_rpc_v3_for_user',
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
        'user_id', p_user_id,
        'score_total', v_score_total,
        'score_nutrition', v_score_nutrition,
        'score_hydration', v_score_hydration,
        'score_exercise', v_score_exercise,
        'score_sleep', v_score_sleep,
        'score_mental', v_score_mental,
        'balance_factor', v_balance_factor,
        'subscores', jsonb_build_object(
            'nutrition', jsonb_build_object('baseline', v_b_nutrition, 'completions', v_ac_nutrition, 'data', v_cd_nutrition, 'streak', v_sb_nutrition),
            'hydration', jsonb_build_object('baseline', v_b_hydration, 'completions', v_ac_hydration, 'data', v_cd_hydration, 'streak', v_sb_hydration),
            'exercise',  jsonb_build_object('baseline', v_b_exercise,  'completions', v_ac_exercise,  'data', v_cd_exercise,  'streak', v_sb_exercise),
            'sleep',     jsonb_build_object('baseline', v_b_sleep,     'completions', v_ac_sleep,     'data', v_cd_sleep,     'streak', v_sb_sleep),
            'mental',    jsonb_build_object('baseline', v_b_mental,    'completions', v_ac_mental,    'data', v_cd_mental,    'streak', v_sb_mental)
        ),
        'confidence', v_confidence,
        'model_version', p_model_version
    );
END;
$$;

-- Service-role only — callers must use the admin Supabase client.
REVOKE ALL ON FUNCTION public.health_compute_vitana_index_for_user(UUID, DATE, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.health_compute_vitana_index_for_user(UUID, DATE, TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION public.health_compute_vitana_index_for_user(UUID, DATE, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.health_compute_vitana_index_for_user(UUID, DATE, TEXT) TO service_role;

COMMENT ON FUNCTION public.health_compute_vitana_index_for_user(UUID, DATE, TEXT) IS
  'Service-role-only sibling of health_compute_vitana_index() that takes user_id as a parameter. Used by the calendar completion loop to trigger a recompute for a specific user without needing their JWT.';

NOTIFY pgrst, 'reload schema';

COMMIT;
