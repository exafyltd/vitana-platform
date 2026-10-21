-- =============================================================================
-- G1 — Bridge community engagement to the Mental pillar
-- Plan: .claude/plans/community-user-role-make-purring-pascal.md
-- Date: 2026-04-24
--
-- Why this migration: the canonical wellness-tag → pillar map in
-- services/gateway/src/lib/vitana-pillars.ts was updated so the Mental pillar
-- includes community-engagement tags (social, community, meetup, invite,
-- group, chat, leadership, connection, match) alongside mindfulness /
-- meditation / learning / journal. This migration brings the DB-side
-- twin into lockstep:
--
--   1. health_compute_vitana_index() v3 hard-codes v_mental_tags. Extend it.
--   2. vitana_contribution_vector_from_source_ref() assigns small mental
--      bumps for community source_refs. Strengthen them to 4–6 so the Mental
--      `completions` sub-score actually moves when users do the things the
--      90-day waves already ask them to do. Add the three community source_refs
--      the trigger was missing (try_live_room, create_live_room, mentor_newcomer,
--      weakness_mental).
--   3. Backfill: recompute contribution_vector on existing autopilot_recommendations
--      rows so the ranker immediately sees the correct weights.
--   4. Recompute vitana_index_scores for all users today so the Mental pillar
--      reflects the new tag coverage against historical calendar completions.
--
-- Idempotent: CREATE OR REPLACE, UPDATE, SELECT-into-function calls.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Rewrite health_compute_vitana_index() v3 to include community tags
--    in v_mental_tags. Everything else stays identical to the v3 RPC from
--    migration 20260423130000_vitana_index_compute_v3.sql.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.health_compute_vitana_index(p_date DATE DEFAULT CURRENT_DATE)
RETURNS TABLE (
    user_id UUID,
    score_total INTEGER,
    score_nutrition INTEGER,
    score_hydration INTEGER,
    score_exercise INTEGER,
    score_sleep INTEGER,
    score_mental INTEGER,
    confidence NUMERIC,
    model_version TEXT,
    feature_inputs JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
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
$$;

GRANT EXECUTE ON FUNCTION public.health_compute_vitana_index(DATE) TO authenticated;

COMMENT ON FUNCTION public.health_compute_vitana_index(DATE) IS
  'v3 compute RPC with community-engagement tags folded into the Mental pillar (G1). Lockstep with PILLAR_TAGS in services/gateway/src/lib/vitana-pillars.ts.';

-- -----------------------------------------------------------------------------
-- 2. Strengthen community source_refs in the contribution_vector trigger.
--    Community actions now carry mental=5 (up from 2–4) so the Mental pillar
--    moves meaningfully when users meet, match, invite, chat, or create.
--    Adds missing source_refs: try_live_room, create_live_room, mentor_newcomer,
--    weakness_mental.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.vitana_contribution_vector_from_source_ref(p_source_ref TEXT)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_nutrition INTEGER := 0;
  v_hydration INTEGER := 0;
  v_exercise  INTEGER := 0;
  v_sleep     INTEGER := 0;
  v_mental    INTEGER := 0;
BEGIN
  CASE COALESCE(p_source_ref, '')
    -- Weakness-driven
    WHEN 'weakness_movement' THEN v_exercise := 6;
    WHEN 'weakness_nutrition' THEN v_nutrition := 6;
    WHEN 'weakness_sleep' THEN v_sleep := 6;
    WHEN 'weakness_stress' THEN v_mental := 6;
    WHEN 'weakness_mental' THEN v_mental := 6;
    WHEN 'weakness_social' THEN v_mental := 6; -- G1: community engagement = mental (bumped 4→6)
    WHEN 'weakness_hydration' THEN v_hydration := 6;

    -- Engagement (strengthened per G1: community = mental)
    WHEN 'engage_health' THEN v_exercise := 2;
    WHEN 'engage_meetup' THEN v_mental := 6; -- bumped 4→6
    WHEN 'deepen_connection' THEN v_mental := 6; -- bumped 4→6
    WHEN 'set_goal' THEN v_mental := 4;
    WHEN 'start_streak' THEN v_exercise := 4;

    -- Mood-driven
    WHEN 'mood_support' THEN v_mental := 6;
    WHEN 'mood_energy' THEN v_exercise := 4;

    -- Onboarding
    WHEN 'onboarding_profile', 'onboarding_avatar' THEN
      v_nutrition := 1; v_hydration := 1; v_exercise := 1; v_sleep := 1; v_mental := 1;
    WHEN 'onboarding_explore' THEN v_mental := 4; -- bumped 2→4
    WHEN 'onboarding_interests' THEN v_mental := 2;
    WHEN 'onboarding_maxina' THEN v_mental := 4; -- bumped 2→4
    WHEN 'onboarding_diary', 'onboarding_diary_day0' THEN v_mental := 4;
    WHEN 'onboarding_health' THEN v_exercise := 2;
    WHEN 'onboarding_matches', 'onboarding_discover_matches', 'engage_matches' THEN
      v_mental := 4; -- bumped 2→4
    WHEN 'onboarding_group' THEN v_mental := 4; -- bumped 2→4

    -- Advanced community (Wave 4–6)
    WHEN 'share_expertise' THEN v_mental := 4; -- bumped 2→4
    WHEN 'invite_friend' THEN v_mental := 5; -- bumped 2→5 (growth + mental)
    WHEN 'try_live_room' THEN v_mental := 5; -- new
    WHEN 'create_live_room' THEN v_mental := 6; -- new
    WHEN 'mentor_newcomer' THEN v_mental := 6; -- new

    -- Streak notifications (small universal halo)
    WHEN 'streak_celebration', 'streak_continue' THEN
      v_nutrition := 1; v_hydration := 1; v_exercise := 1; v_sleep := 1; v_mental := 1;

    ELSE
      RETURN '{}'::JSONB;
  END CASE;

  RETURN jsonb_build_object(
    'nutrition', v_nutrition,
    'hydration', v_hydration,
    'exercise',  v_exercise,
    'sleep',     v_sleep,
    'mental',    v_mental
  );
END;
$$;

COMMENT ON FUNCTION public.vitana_contribution_vector_from_source_ref(TEXT) IS
  'Maps autopilot source_ref to 5-pillar JSONB contribution vector. G1: community actions now carry mental=4–6 to reflect that community engagement is a primary driver of the Mental pillar. Kept in lockstep with PILLAR_TAGS in services/gateway/src/lib/vitana-pillars.ts.';

-- -----------------------------------------------------------------------------
-- 2b. Rewrite health_compute_vitana_index_for_user (admin-callable variant)
--     so it also includes community engagement tags in v_mental_tags.
--     This is the function the calendar-completion trigger + /manual/log
--     endpoint call, so this is where user-visible Index updates come from.
-- -----------------------------------------------------------------------------

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
$$;

COMMENT ON FUNCTION public.health_compute_vitana_index_for_user(UUID, DATE, TEXT) IS
  'Admin-callable v3 compute. G1: community engagement tags are first-class Mental drivers. Lockstep with PILLAR_TAGS in services/gateway/src/lib/vitana-pillars.ts.';

-- -----------------------------------------------------------------------------
-- 3. Backfill existing autopilot_recommendations rows.
-- -----------------------------------------------------------------------------

UPDATE public.autopilot_recommendations
SET contribution_vector = public.vitana_contribution_vector_from_source_ref(source_ref)
WHERE source_ref IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 4. Recompute vitana_index_scores for today for all users who have a row
--    today. Using health_compute_vitana_index_for_user (service-role variant)
--    so the caller's auth context doesn't matter.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
    v_user RECORD;
BEGIN
    FOR v_user IN
        SELECT DISTINCT user_id FROM public.vitana_index_scores
        WHERE date = CURRENT_DATE
    LOOP
        PERFORM public.health_compute_vitana_index_for_user(v_user.user_id, CURRENT_DATE);
    END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
