-- VTID-05163 (Health Hub Phase 1 / B3, program VTID-05020) — the Vitana Index
-- dual-compute (plan docs/validation/VTID-05163/plan-sparring.md, B Change 10):
--
--   * vitana_index_project_for_user(p_user_id, p_device_from, p_self_from)
--       A READ-ONLY copy of health_compute_vitana_index_for_user's arithmetic
--       (20260424120000_pillar_tags_community_engagement.sql) with one
--       difference: the feature rows it counts come from ONE set built from
--       health_features_daily (legacy) and health_features_daily_v2 (derived
--       from the health store, VTID-05162), per key class:
--         - device keys (the seven D6a keys): v2 for date >= p_device_from,
--           legacy before that date and when p_device_from IS NULL;
--         - self-logged keys with a store code (meal_log, water_intake,
--           mood_entry, meditation_minutes): v2 for date >= p_self_from,
--           legacy before that date and when p_self_from IS NULL;
--         - keys with no store code (biomarker_glucose, biomarker_hba1c,
--           macro_balance, hydration_log, wearable_sleep_stages,
--           wearable_stress, journal_entry): always legacy.
--       (NULL, NULL) is the legacy Index, (D0, NULL) Stage 1 (device scope),
--       (D0, D0s) Stage 2 (full scope). It writes nothing.
--   * vitana_pillar_streak_days_projected(p_user_id, p_pillar_key,
--       p_device_from, p_self_from) — vitana_pillar_streak_days
--       (20260423130000_vitana_index_compute_v3.sql) over the same row set.
--   * vitana_index_projected_feature_rows(p_user_id, p_device_from, p_self_from)
--       — the row set itself, shared by the two functions above (decision
--       inside the plan: one definition of the routing rule, not six copies).
--   * vitana_index_dual_compute — one row per (member, run date, scope) written
--       by the gateway's final daily-recompute step (Change 11); aggregates
--       only leave it (Change 12). Purged after 120 days by the same step.
--
-- All three functions are STABLE (a write inside them raises) and EXECUTE for
-- service_role only. The live Index functions, the calendar trigger, the
-- scheduler stage and every reader of vitana_index_scores are NOT touched.
-- The SQL test (scripts/ci/sql-tests/run-index-dual-compute-test.sh, CI
-- SQL-INDEX-DUAL-COMPUTE.yml) is the functional drift guard: identical rows
-- in both tables must give the live function's exact result for every
-- (p_device_from, p_self_from), so any change to the live formula fails CI
-- until this copy follows.
--
-- APPLY TARGET: Aurora only (0T; production after the cutover). Never
-- Supabase — it reads health_features_daily_v2 (Aurora only, VTID-05162).
-- Same placement guard as the VTID-05158 / 05161 / 05162 migrations;
-- MIGRATION-DRIFT-CHECK lists vitana_index_dual_compute in
-- `aurora_only_tables`. vitana_index_dual_compute has user_id uuid NOT NULL in
-- public, no FK to auth.users and no erasure_registry row: erase_user_data()
-- finds it by its catalogue scan.

BEGIN;

-- 1. Placement guard (VTID-05158 pattern).
DO $guard$
BEGIN
  IF coalesce(current_setting('vitana.health_store_target', true), '') <> 'aurora'
     AND to_regclass('auth.users') IS NOT NULL
     AND to_regclass('storage.objects') IS NOT NULL THEN
    RAISE EXCEPTION 'VTID-05163 health store placement guard: this database has auth.users and storage.objects (Supabase). vitana_index_dual_compute and the Index projection read health_features_daily_v2 and are Aurora-only. On Aurora with an auth shim, SET vitana.health_store_target = ''aurora'' first.'
      USING ERRCODE = 'P0001';
  END IF;
  IF to_regclass('public.health_features_daily_v2') IS NULL THEN
    RAISE EXCEPTION 'VTID-05163: health_features_daily_v2 is missing — apply 20261014100700_vtid_05162_health_features_v2.sql first.'
      USING ERRCODE = 'P0001';
  END IF;
END
$guard$;

SET LOCAL lock_timeout = '5s';

-- 2. The projected feature row set.
CREATE OR REPLACE FUNCTION public.vitana_index_projected_feature_rows(
    p_user_id UUID,
    p_device_from DATE,
    p_self_from DATE
)
RETURNS TABLE (date DATE, feature_key TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT l.date, l.feature_key
      FROM public.health_features_daily l
     WHERE l.user_id = p_user_id
       AND NOT (
             (p_device_from IS NOT NULL AND l.date >= p_device_from
              AND l.feature_key = ANY (ARRAY['wearable_heart_rate','wearable_steps','wearable_workout','vo2_max',
                                             'wearable_sleep_duration','wearable_sleep_efficiency','wearable_hrv']))
          OR (p_self_from IS NOT NULL AND l.date >= p_self_from
              AND l.feature_key = ANY (ARRAY['meal_log','water_intake','mood_entry','meditation_minutes']))
           )
    UNION ALL
    SELECT v.date, v.feature_key
      FROM public.health_features_daily_v2 v
     WHERE v.user_id = p_user_id
       AND (
             (p_device_from IS NOT NULL AND v.date >= p_device_from
              AND v.feature_key = ANY (ARRAY['wearable_heart_rate','wearable_steps','wearable_workout','vo2_max',
                                             'wearable_sleep_duration','wearable_sleep_efficiency','wearable_hrv']))
          OR (p_self_from IS NOT NULL AND v.date >= p_self_from
              AND v.feature_key = ANY (ARRAY['meal_log','water_intake','mood_entry','meditation_minutes']))
           )
$$;

COMMENT ON FUNCTION public.vitana_index_projected_feature_rows(UUID, DATE, DATE) IS
  'VTID-05163: the (date, feature_key) rows the Index projection counts — device keys from health_features_daily_v2 from p_device_from, coded self-logged keys from v2 from p_self_from, everything else from health_features_daily. Read-only. Aurora only.';

-- 3. Streak over the projected row set (copy of vitana_pillar_streak_days).
CREATE OR REPLACE FUNCTION public.vitana_pillar_streak_days_projected(
    p_user_id UUID,
    p_pillar_key TEXT,
    p_device_from DATE,
    p_self_from DATE
)
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
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
    v_tags := CASE p_pillar_key
        WHEN 'nutrition' THEN ARRAY['nutrition','meal','food-log']
        WHEN 'hydration' THEN ARRAY['hydration','water']
        WHEN 'exercise'  THEN ARRAY['movement','workout','walk','steps','exercise']
        WHEN 'sleep'     THEN ARRAY['sleep','rest','recovery']
        WHEN 'mental'    THEN ARRAY['mindfulness','mental','stress','meditation','learning','journal']
        ELSE ARRAY[]::TEXT[]
    END;

    v_features := CASE p_pillar_key
        WHEN 'nutrition' THEN ARRAY['biomarker_glucose','biomarker_hba1c','meal_log','macro_balance']
        WHEN 'hydration' THEN ARRAY['water_intake','hydration_log']
        WHEN 'exercise'  THEN ARRAY['wearable_heart_rate','wearable_steps','wearable_workout','vo2_max']
        WHEN 'sleep'     THEN ARRAY['wearable_sleep_duration','wearable_sleep_efficiency','wearable_hrv','wearable_sleep_stages']
        WHEN 'mental'    THEN ARRAY['wearable_stress','mood_entry','meditation_minutes','journal_entry']
        ELSE ARRAY[]::TEXT[]
    END;

    FOR i IN 0..89 LOOP
        v_day := CURRENT_DATE - i;

        v_signal := EXISTS (
            SELECT 1 FROM public.calendar_events
            WHERE user_id = p_user_id
              AND completion_status = 'completed'
              AND DATE(COALESCE(completed_at, end_time)) = v_day
              AND wellness_tags && v_tags
        );

        IF NOT v_signal THEN
            v_signal := EXISTS (
                SELECT 1 FROM public.vitana_index_projected_feature_rows(p_user_id, p_device_from, p_self_from) f
                WHERE f.date = v_day
                  AND f.feature_key = ANY(v_features)
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

COMMENT ON FUNCTION public.vitana_pillar_streak_days_projected(UUID, TEXT, DATE, DATE) IS
  'VTID-05163: vitana_pillar_streak_days over vitana_index_projected_feature_rows. Read-only. Aurora only.';

-- 4. The projection (copy of health_compute_vitana_index_for_user, no INSERT).
CREATE OR REPLACE FUNCTION public.vitana_index_project_for_user(
    p_user_id UUID,
    p_device_from DATE,
    p_self_from DATE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
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
    FROM public.vitana_index_projected_feature_rows(p_user_id, p_device_from, p_self_from) f
    WHERE f.date >= (CURRENT_DATE - INTERVAL '7 days')
      AND f.feature_key = ANY(ARRAY['biomarker_glucose','biomarker_hba1c','meal_log','macro_balance']);

    SELECT CASE WHEN COUNT(*) >= 11 THEN 40 WHEN COUNT(*) >= 4 THEN 25 WHEN COUNT(*) >= 1 THEN 15 ELSE 0 END
    INTO v_cd_hydration
    FROM public.vitana_index_projected_feature_rows(p_user_id, p_device_from, p_self_from) f
    WHERE f.date >= (CURRENT_DATE - INTERVAL '7 days')
      AND f.feature_key = ANY(ARRAY['water_intake','hydration_log']);

    SELECT CASE WHEN COUNT(*) >= 11 THEN 40 WHEN COUNT(*) >= 4 THEN 25 WHEN COUNT(*) >= 1 THEN 15 ELSE 0 END
    INTO v_cd_exercise
    FROM public.vitana_index_projected_feature_rows(p_user_id, p_device_from, p_self_from) f
    WHERE f.date >= (CURRENT_DATE - INTERVAL '7 days')
      AND f.feature_key = ANY(ARRAY['wearable_heart_rate','wearable_steps','wearable_workout','vo2_max']);

    SELECT CASE WHEN COUNT(*) >= 11 THEN 40 WHEN COUNT(*) >= 4 THEN 25 WHEN COUNT(*) >= 1 THEN 15 ELSE 0 END
    INTO v_cd_sleep
    FROM public.vitana_index_projected_feature_rows(p_user_id, p_device_from, p_self_from) f
    WHERE f.date >= (CURRENT_DATE - INTERVAL '7 days')
      AND f.feature_key = ANY(ARRAY['wearable_sleep_duration','wearable_sleep_efficiency','wearable_hrv','wearable_sleep_stages']);

    SELECT CASE WHEN COUNT(*) >= 11 THEN 40 WHEN COUNT(*) >= 4 THEN 25 WHEN COUNT(*) >= 1 THEN 15 ELSE 0 END
    INTO v_cd_mental
    FROM public.vitana_index_projected_feature_rows(p_user_id, p_device_from, p_self_from) f
    WHERE f.date >= (CURRENT_DATE - INTERVAL '7 days')
      AND f.feature_key = ANY(ARRAY['wearable_stress','mood_entry','meditation_minutes','journal_entry']);

    v_streak := public.vitana_pillar_streak_days_projected(p_user_id, 'nutrition', p_device_from, p_self_from);
    v_sb_nutrition := CASE WHEN v_streak >= 30 THEN 40 WHEN v_streak >= 14 THEN 25 WHEN v_streak >= 7 THEN 15 ELSE 0 END;
    v_streak := public.vitana_pillar_streak_days_projected(p_user_id, 'hydration', p_device_from, p_self_from);
    v_sb_hydration := CASE WHEN v_streak >= 30 THEN 40 WHEN v_streak >= 14 THEN 25 WHEN v_streak >= 7 THEN 15 ELSE 0 END;
    v_streak := public.vitana_pillar_streak_days_projected(p_user_id, 'exercise', p_device_from, p_self_from);
    v_sb_exercise := CASE WHEN v_streak >= 30 THEN 40 WHEN v_streak >= 14 THEN 25 WHEN v_streak >= 7 THEN 15 ELSE 0 END;
    v_streak := public.vitana_pillar_streak_days_projected(p_user_id, 'sleep', p_device_from, p_self_from);
    v_sb_sleep := CASE WHEN v_streak >= 30 THEN 40 WHEN v_streak >= 14 THEN 25 WHEN v_streak >= 7 THEN 15 ELSE 0 END;
    v_streak := public.vitana_pillar_streak_days_projected(p_user_id, 'mental', p_device_from, p_self_from);
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

    RETURN jsonb_build_object(
        'ok', true,
        'user_id', p_user_id,
        'device_from', p_device_from,
        'self_from', p_self_from,
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
        'confidence', v_confidence
    );
END;
$$;

COMMENT ON FUNCTION public.vitana_index_project_for_user(UUID, DATE, DATE) IS
  'VTID-05163: read-only Vitana Index projection — health_compute_vitana_index_for_user''s arithmetic over vitana_index_projected_feature_rows. Writes nothing. Aurora only. Service role only.';

REVOKE ALL ON FUNCTION public.vitana_index_projected_feature_rows(UUID, DATE, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vitana_pillar_streak_days_projected(UUID, TEXT, DATE, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vitana_index_project_for_user(UUID, DATE, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vitana_index_projected_feature_rows(UUID, DATE, DATE) TO service_role;
GRANT EXECUTE ON FUNCTION public.vitana_pillar_streak_days_projected(UUID, TEXT, DATE, DATE) TO service_role;
GRANT EXECUTE ON FUNCTION public.vitana_index_project_for_user(UUID, DATE, DATE) TO service_role;

-- 5. vitana_index_dual_compute.
CREATE TABLE IF NOT EXISTS public.vitana_index_dual_compute (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  user_id              uuid NOT NULL,
  date                 date NOT NULL,
  scope                text NOT NULL CONSTRAINT vitana_index_dual_compute_scope_check CHECK (scope IN ('device', 'all')),
  live_total           integer,
  legacy_total         integer,
  v2_total             integer,
  -- {pillar: {data, streak}} for the legacy projection (NULL, NULL) and the scope's projection.
  legacy_pillars       jsonb,
  v2_pillars           jsonb,
  device_rows_missing  integer NOT NULL DEFAULT 0 CONSTRAINT vitana_index_dual_compute_dev_missing_check CHECK (device_rows_missing >= 0),
  device_rows_extra    integer NOT NULL DEFAULT 0 CONSTRAINT vitana_index_dual_compute_dev_extra_check CHECK (device_rows_extra >= 0),
  self_rows_missing    integer NOT NULL DEFAULT 0 CONSTRAINT vitana_index_dual_compute_self_missing_check CHECK (self_rows_missing >= 0),
  self_rows_extra      integer NOT NULL DEFAULT 0 CONSTRAINT vitana_index_dual_compute_self_extra_check CHECK (self_rows_extra >= 0),
  diff_class           text[] NOT NULL DEFAULT '{}'::text[] CONSTRAINT vitana_index_dual_compute_diff_class_check CHECK (
    diff_class <@ ARRAY['consent_withheld', 'writer_not_rerouted', 'derivation_pending', 'derivation_gap',
                        'store_write_failed', 'formula_drift', 'not_comparable']::text[]),
  formula_ok           boolean,
  -- Set when the comparison itself failed for this member (a job failure); totals are then NULL.
  failure_code         text,
  computed_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vitana_index_dual_compute_key UNIQUE (tenant_id, user_id, date, scope)
);
CREATE INDEX IF NOT EXISTS vitana_index_dual_compute_date_scope_idx
  ON public.vitana_index_dual_compute (date, scope);

ALTER TABLE public.vitana_index_dual_compute ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.vitana_index_dual_compute FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.vitana_index_dual_compute TO service_role;

COMMENT ON TABLE public.vitana_index_dual_compute IS
  'VTID-05163: per member-day comparison of the live Vitana Index with its projections (legacy vs derived inputs), written by the final daily-recompute step; aggregates only leave it. Purged after 120 days. Aurora only. Service role only.';

COMMIT;
