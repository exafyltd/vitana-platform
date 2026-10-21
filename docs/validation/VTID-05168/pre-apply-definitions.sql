CREATE OR REPLACE FUNCTION public.health_compute_vitana_index(p_date date DEFAULT CURRENT_DATE)
 RETURNS TABLE(user_id uuid, score_total integer, score_nutrition integer, score_hydration integer, score_exercise integer, score_sleep integer, score_mental integer, confidence numeric, model_version text, feature_inputs jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
    v_user_id UUID := auth.uid();
    v_tenant_id UUID;
    v_baseline_nutrition INTEGER := 0;
    v_baseline_hydration INTEGER := 0;
    v_baseline_exercise  INTEGER := 0;
    v_baseline_sleep     INTEGER := 0;
    v_baseline_mental    INTEGER := 0;
    v_ac_nutrition INTEGER := 0;
    v_ac_hydration INTEGER := 0;
    v_ac_exercise  INTEGER := 0;
    v_ac_sleep     INTEGER := 0;
    v_ac_mental    INTEGER := 0;
    v_cd_nutrition INTEGER := 0;
    v_cd_hydration INTEGER := 0;
    v_cd_exercise  INTEGER := 0;
    v_cd_sleep     INTEGER := 0;
    v_cd_mental    INTEGER := 0;
    v_s_nutrition INTEGER := 0;
    v_s_hydration INTEGER := 0;
    v_s_exercise  INTEGER := 0;
    v_s_sleep     INTEGER := 0;
    v_s_mental    INTEGER := 0;
    v_p_nutrition INTEGER := 0;
    v_p_hydration INTEGER := 0;
    v_p_exercise  INTEGER := 0;
    v_p_sleep     INTEGER := 0;
    v_p_mental    INTEGER := 0;
    v_raw_sum INTEGER := 0;
    v_min_pillar INTEGER := 0;
    v_max_pillar INTEGER := 0;
    v_ratio NUMERIC := 1.0;
    v_balance_factor NUMERIC := 1.0;
    v_score_total INTEGER := 0;
    v_baseline_answers JSONB;
    v_ev RECORD;
    v_nutrition_tags TEXT[] := ARRAY['nutrition','meal','food-log'];
    v_hydration_tags TEXT[] := ARRAY['hydration','water'];
    v_exercise_tags  TEXT[] := ARRAY['movement','workout','walk','steps','exercise'];
    v_sleep_tags     TEXT[] := ARRAY['sleep','rest','recovery'];
    -- G1: community engagement tags are now first-class Mental-pillar drivers.
    v_mental_tags    TEXT[] := ARRAY[
      'mindfulness','mental','stress','meditation','learning','journal',
      'social','community','meetup','invite','group','chat',
      'leadership','connection','match'
    ];
    v_feature_inputs JSONB;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'AUTH_REQUIRED';
    END IF;

    SELECT tenant_id INTO v_tenant_id
    FROM public.user_tenants
    WHERE user_id = v_user_id
    LIMIT 1;
    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000000'::UUID;
    END IF;

    -- -------------------------------------------------------------------------
    -- 1. Baseline sub-scores (max 40 each) from vitana_index_baseline_survey
    -- -------------------------------------------------------------------------
    SELECT answers INTO v_baseline_answers
    FROM public.vitana_index_baseline_survey
    WHERE user_id = v_user_id
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_baseline_answers IS NOT NULL THEN
        v_baseline_nutrition := CASE COALESCE((v_baseline_answers->>'nutrition')::INT, 0)
            WHEN 1 THEN 10 WHEN 2 THEN 20 WHEN 3 THEN 25 WHEN 4 THEN 32 WHEN 5 THEN 40
            ELSE 0 END;
        v_baseline_hydration := CASE COALESCE((v_baseline_answers->>'hydration')::INT, 0)
            WHEN 1 THEN 10 WHEN 2 THEN 20 WHEN 3 THEN 25 WHEN 4 THEN 32 WHEN 5 THEN 40
            ELSE 0 END;
        v_baseline_exercise := CASE COALESCE((v_baseline_answers->>'exercise')::INT, 0)
            WHEN 1 THEN 10 WHEN 2 THEN 20 WHEN 3 THEN 25 WHEN 4 THEN 32 WHEN 5 THEN 40
            ELSE 0 END;
        v_baseline_sleep := CASE COALESCE((v_baseline_answers->>'sleep')::INT, 0)
            WHEN 1 THEN 10 WHEN 2 THEN 20 WHEN 3 THEN 25 WHEN 4 THEN 32 WHEN 5 THEN 40
            ELSE 0 END;
        v_baseline_mental := CASE COALESCE((v_baseline_answers->>'mental')::INT, 0)
            WHEN 1 THEN 10 WHEN 2 THEN 20 WHEN 3 THEN 25 WHEN 4 THEN 32 WHEN 5 THEN 40
            ELSE 0 END;
    END IF;

    -- -------------------------------------------------------------------------
    -- 2. Action completions sub-scores (last 30 days, max 80 per pillar)
    -- -------------------------------------------------------------------------
    FOR v_ev IN
        SELECT wellness_tags
        FROM public.calendar_events
        WHERE user_id = v_user_id
          AND completion_status = 'completed'
          AND start_time >= (p_date::TIMESTAMPTZ - INTERVAL '30 days')
          AND start_time < (p_date::TIMESTAMPTZ + INTERVAL '1 day')
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

    -- -------------------------------------------------------------------------
    -- 3. Connected data sub-scores (last 7 days, max 40 per pillar)
    -- -------------------------------------------------------------------------
    SELECT
      CASE
        WHEN COUNT(*) FILTER (WHERE feature_key IN ('meal_log','macro_balance','biomarker_glucose','biomarker_hba1c')) >= 11 THEN 40
        WHEN COUNT(*) FILTER (WHERE feature_key IN ('meal_log','macro_balance','biomarker_glucose','biomarker_hba1c')) >= 4  THEN 25
        WHEN COUNT(*) FILTER (WHERE feature_key IN ('meal_log','macro_balance','biomarker_glucose','biomarker_hba1c')) >= 1  THEN 15
        ELSE 0
      END,
      CASE
        WHEN COUNT(*) FILTER (WHERE feature_key IN ('water_intake','hydration_log')) >= 11 THEN 40
        WHEN COUNT(*) FILTER (WHERE feature_key IN ('water_intake','hydration_log')) >= 4  THEN 25
        WHEN COUNT(*) FILTER (WHERE feature_key IN ('water_intake','hydration_log')) >= 1  THEN 15
        ELSE 0
      END,
      CASE
        WHEN COUNT(*) FILTER (WHERE feature_key IN ('wearable_heart_rate','wearable_steps','wearable_workout','vo2_max')) >= 11 THEN 40
        WHEN COUNT(*) FILTER (WHERE feature_key IN ('wearable_heart_rate','wearable_steps','wearable_workout','vo2_max')) >= 4  THEN 25
        WHEN COUNT(*) FILTER (WHERE feature_key IN ('wearable_heart_rate','wearable_steps','wearable_workout','vo2_max')) >= 1  THEN 15
        ELSE 0
      END,
      CASE
        WHEN COUNT(*) FILTER (WHERE feature_key IN ('wearable_sleep_duration','wearable_sleep_efficiency','wearable_hrv','wearable_sleep_stages')) >= 11 THEN 40
        WHEN COUNT(*) FILTER (WHERE feature_key IN ('wearable_sleep_duration','wearable_sleep_efficiency','wearable_hrv','wearable_sleep_stages')) >= 4  THEN 25
        WHEN COUNT(*) FILTER (WHERE feature_key IN ('wearable_sleep_duration','wearable_sleep_efficiency','wearable_hrv','wearable_sleep_stages')) >= 1  THEN 15
        ELSE 0
      END,
      CASE
        WHEN COUNT(*) FILTER (WHERE feature_key IN ('wearable_stress','mood_entry','meditation_minutes','journal_entry')) >= 11 THEN 40
        WHEN COUNT(*) FILTER (WHERE feature_key IN ('wearable_stress','mood_entry','meditation_minutes','journal_entry')) >= 4  THEN 25
        WHEN COUNT(*) FILTER (WHERE feature_key IN ('wearable_stress','mood_entry','meditation_minutes','journal_entry')) >= 1  THEN 15
        ELSE 0
      END
    INTO v_cd_nutrition, v_cd_hydration, v_cd_exercise, v_cd_sleep, v_cd_mental
    FROM public.health_features_daily
    WHERE user_id = v_user_id
      AND date >= (p_date - INTERVAL '7 days');

    -- -------------------------------------------------------------------------
    -- 4. Streak bonus (max 40 per pillar) via helper RPC
    -- -------------------------------------------------------------------------
    SELECT public.vitana_pillar_streak_days(v_user_id, 'nutrition', p_date) INTO v_s_nutrition;
    SELECT public.vitana_pillar_streak_days(v_user_id, 'hydration', p_date) INTO v_s_hydration;
    SELECT public.vitana_pillar_streak_days(v_user_id, 'exercise',  p_date) INTO v_s_exercise;
    SELECT public.vitana_pillar_streak_days(v_user_id, 'sleep',     p_date) INTO v_s_sleep;
    SELECT public.vitana_pillar_streak_days(v_user_id, 'mental',    p_date) INTO v_s_mental;

    v_s_nutrition := CASE WHEN v_s_nutrition >= 30 THEN 40 WHEN v_s_nutrition >= 14 THEN 25 WHEN v_s_nutrition >= 7 THEN 15 ELSE 0 END;
    v_s_hydration := CASE WHEN v_s_hydration >= 30 THEN 40 WHEN v_s_hydration >= 14 THEN 25 WHEN v_s_hydration >= 7 THEN 15 ELSE 0 END;
    v_s_exercise  := CASE WHEN v_s_exercise  >= 30 THEN 40 WHEN v_s_exercise  >= 14 THEN 25 WHEN v_s_exercise  >= 7 THEN 15 ELSE 0 END;
    v_s_sleep     := CASE WHEN v_s_sleep     >= 30 THEN 40 WHEN v_s_sleep     >= 14 THEN 25 WHEN v_s_sleep     >= 7 THEN 15 ELSE 0 END;
    v_s_mental    := CASE WHEN v_s_mental    >= 30 THEN 40 WHEN v_s_mental    >= 14 THEN 25 WHEN v_s_mental    >= 7 THEN 15 ELSE 0 END;

    -- -------------------------------------------------------------------------
    -- 5. Sum per pillar (cap 200)
    -- -------------------------------------------------------------------------
    v_p_nutrition := LEAST(v_baseline_nutrition + v_ac_nutrition + v_cd_nutrition + v_s_nutrition, 200);
    v_p_hydration := LEAST(v_baseline_hydration + v_ac_hydration + v_cd_hydration + v_s_hydration, 200);
    v_p_exercise  := LEAST(v_baseline_exercise  + v_ac_exercise  + v_cd_exercise  + v_s_exercise,  200);
    v_p_sleep     := LEAST(v_baseline_sleep     + v_ac_sleep     + v_cd_sleep     + v_s_sleep,     200);
    v_p_mental    := LEAST(v_baseline_mental    + v_ac_mental    + v_cd_mental    + v_s_mental,    200);

    v_raw_sum := v_p_nutrition + v_p_hydration + v_p_exercise + v_p_sleep + v_p_mental;

    v_max_pillar := GREATEST(v_p_nutrition, v_p_hydration, v_p_exercise, v_p_sleep, v_p_mental);
    v_min_pillar := LEAST(v_p_nutrition, v_p_hydration, v_p_exercise, v_p_sleep, v_p_mental);
    v_ratio := CASE WHEN v_max_pillar > 0 THEN v_min_pillar::NUMERIC / v_max_pillar ELSE 1.0 END;
    v_balance_factor := CASE
        WHEN v_ratio >= 0.70 THEN 1.00
        WHEN v_ratio >= 0.50 THEN 0.90
        WHEN v_ratio >= 0.30 THEN 0.80
        ELSE 0.70
    END;

    v_score_total := LEAST(999, ROUND(v_raw_sum * v_balance_factor))::INTEGER;

    v_feature_inputs := jsonb_build_object(
        'source', 'compute_rpc_v3_community_bridge',
        'raw_sum', v_raw_sum,
        'ratio', v_ratio,
        'balance_factor', v_balance_factor,
        'subscores', jsonb_build_object(
            'nutrition', jsonb_build_object('baseline', v_baseline_nutrition, 'completions', v_ac_nutrition, 'data', v_cd_nutrition, 'streak', v_s_nutrition),
            'hydration', jsonb_build_object('baseline', v_baseline_hydration, 'completions', v_ac_hydration, 'data', v_cd_hydration, 'streak', v_s_hydration),
            'exercise',  jsonb_build_object('baseline', v_baseline_exercise,  'completions', v_ac_exercise,  'data', v_cd_exercise,  'streak', v_s_exercise),
            'sleep',     jsonb_build_object('baseline', v_baseline_sleep,     'completions', v_ac_sleep,     'data', v_cd_sleep,     'streak', v_s_sleep),
            'mental',    jsonb_build_object('baseline', v_baseline_mental,    'completions', v_ac_mental,    'data', v_cd_mental,    'streak', v_s_mental)
        )
    );

    INSERT INTO public.vitana_index_scores (
        tenant_id, user_id, date, score_total,
        score_nutrition, score_hydration, score_exercise, score_sleep, score_mental,
        confidence, model_version, feature_inputs, updated_at
    ) VALUES (
        v_tenant_id, v_user_id, p_date, v_score_total,
        v_p_nutrition, v_p_hydration, v_p_exercise, v_p_sleep, v_p_mental,
        0.85, 'v3-5pillar', v_feature_inputs, NOW()
    )
    ON CONFLICT (tenant_id, user_id, date) DO UPDATE SET
        score_total = EXCLUDED.score_total,
        score_nutrition = EXCLUDED.score_nutrition,
        score_hydration = EXCLUDED.score_hydration,
        score_exercise = EXCLUDED.score_exercise,
        score_sleep = EXCLUDED.score_sleep,
        score_mental = EXCLUDED.score_mental,
        confidence = EXCLUDED.confidence,
        model_version = EXCLUDED.model_version,
        feature_inputs = EXCLUDED.feature_inputs,
        updated_at = EXCLUDED.updated_at;

    RETURN QUERY SELECT
        v_user_id, v_score_total,
        v_p_nutrition, v_p_hydration, v_p_exercise, v_p_sleep, v_p_mental,
        0.85::NUMERIC, 'v3-5pillar'::TEXT, v_feature_inputs;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.health_compute_vitana_index(p_date date, p_model_version text DEFAULT 'v3-5pillar'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.health_compute_vitana_index_for_user(p_user_id uuid, p_date date, p_model_version text DEFAULT 'v3-5pillar'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    -- G1: community engagement tags are now first-class Mental-pillar drivers.
    v_mental_tags    TEXT[] := ARRAY[
      'mindfulness','mental','stress','meditation','learning','journal',
      'social','community','meetup','invite','group','chat',
      'leadership','connection','match'
    ];

    v_streak INTEGER;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'USER_ID_REQUIRED');
    END IF;

    SELECT tenant_id INTO v_tenant_id
    FROM public.user_tenants
    WHERE user_id = p_user_id
    LIMIT 1;
    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000000'::UUID;
    END IF;

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

    v_score_nutrition := LEAST(200, v_b_nutrition + v_ac_nutrition + v_cd_nutrition + v_sb_nutrition);
    v_score_hydration := LEAST(200, v_b_hydration + v_ac_hydration + v_cd_hydration + v_sb_hydration);
    v_score_exercise  := LEAST(200, v_b_exercise  + v_ac_exercise  + v_cd_exercise  + v_sb_exercise);
    v_score_sleep     := LEAST(200, v_b_sleep     + v_ac_sleep     + v_cd_sleep     + v_sb_sleep);
    v_score_mental    := LEAST(200, v_b_mental    + v_ac_mental    + v_cd_mental    + v_sb_mental);

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
$function$
;

CREATE OR REPLACE FUNCTION public.scheduler_vitana_index_compute_daily(p_user_id uuid, p_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_start_time TIMESTAMPTZ;
    v_duration_ms INTEGER;
    v_result JSONB;
    v_ok BOOLEAN;
BEGIN
    v_start_time := clock_timestamp();

    v_result := public.health_compute_vitana_index_for_user(
        p_user_id,
        p_date,
        'v3-5pillar'
    );

    v_duration_ms := EXTRACT(MILLISECOND FROM (clock_timestamp() - v_start_time))::INTEGER;
    v_ok := COALESCE((v_result->>'ok')::BOOLEAN, FALSE);

    IF v_ok THEN
        RETURN jsonb_build_object(
            'ok', true,
            'stage', 'index',
            'user_id', p_user_id,
            'date', p_date,
            'duration_ms', v_duration_ms,
            'score_total', v_result->'score_total',
            'model_version', v_result->'model_version'
        );
    ELSE
        RETURN jsonb_build_object(
            'ok', false,
            'stage', 'index',
            'user_id', p_user_id,
            'date', p_date,
            'duration_ms', v_duration_ms,
            'error', COALESCE(v_result->>'error', 'INDEX_COMPUTE_FAILED')
        );
    END IF;
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'ok', false,
        'stage', 'index',
        'user_id', p_user_id,
        'date', p_date,
        'error', SQLERRM
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.vitana_trg_calendar_completion_recompute()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Only react to transitions INTO 'completed' (new row or status change).
  IF NEW.completion_status = 'completed'
     AND (OLD.completion_status IS DISTINCT FROM 'completed')
     AND NEW.user_id IS NOT NULL
  THEN
    BEGIN
      PERFORM public.health_compute_vitana_index_for_user(
        NEW.user_id,
        CURRENT_DATE,
        'v3-5pillar'
      );
    EXCEPTION WHEN OTHERS THEN
      -- Never block a calendar update on a recompute failure.
      RAISE WARNING 'vitana recompute on completion failed: %', SQLERRM;
    END;
  END IF;
  RETURN NEW;
END;
$function$
;
