-- =============================================================================
-- Vitana Index — 6th pillar (Prosperity) + config-driven pillar weights
-- Date: 2026-04-22
-- Plan: .claude/plans/community-user-role-make-purring-pascal.md (Phase A1 + A2)
--
-- Brings the compute RPC in line with the 6-pillar architecture described in
-- the Proactive Guide plan. Two changes:
--   1. score_prosperity (column already exists, added 2026-04-18) is now
--      written by health_compute_vitana_index() — baseline 100 until a real
--      Prosperity signal source lands in Phase 1c of the Proactive Guide plan.
--   2. vitana_index_config gains a pillar_weights jsonb column, default 1.0
--      per pillar (backward-compatible). The RPC multiplies each pillar by
--      its weight before summing.
--
-- Cap stays at 999 (existing scoring_tiers are calibrated against 0-999).
-- Retiring the cap to 1200 is a later tier-recalibration task.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. pillar_weights column on vitana_index_config
-- -----------------------------------------------------------------------------
ALTER TABLE public.vitana_index_config
  ADD COLUMN IF NOT EXISTS pillar_weights jsonb NOT NULL DEFAULT
    '{"physical":1.0,"mental":1.0,"nutritional":1.0,"social":1.0,"environmental":1.0,"prosperity":1.0}'::jsonb;

COMMENT ON COLUMN public.vitana_index_config.pillar_weights IS
  'Per-pillar multiplier applied by health_compute_vitana_index(). Default 1.0 per pillar = equal weighting (backward-compatible). Admin-tunable via Vitana Index Config UI. Accepted keys: physical, mental, nutritional, social, environmental, prosperity.';

-- Backfill: ensure every existing config row has all 6 keys (merge default
-- into whatever's there today).
UPDATE public.vitana_index_config
SET pillar_weights = '{"physical":1.0,"mental":1.0,"nutritional":1.0,"social":1.0,"environmental":1.0,"prosperity":1.0}'::jsonb || COALESCE(pillar_weights, '{}'::jsonb)
WHERE pillar_weights IS NULL
   OR NOT (pillar_weights ? 'physical'
       AND pillar_weights ? 'mental'
       AND pillar_weights ? 'nutritional'
       AND pillar_weights ? 'social'
       AND pillar_weights ? 'environmental'
       AND pillar_weights ? 'prosperity');

-- -----------------------------------------------------------------------------
-- 2. health_compute_vitana_index() v2 — 6 pillars + weights
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.health_compute_vitana_index(
    p_date DATE,
    p_model_version TEXT DEFAULT 'v2'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_feature_inputs JSONB := '{}'::JSONB;
    v_score_physical INTEGER := 100;
    v_score_mental INTEGER := 100;
    v_score_nutritional INTEGER := 100;
    v_score_social INTEGER := 100;
    v_score_environmental INTEGER := 100;
    v_score_prosperity INTEGER := 100;
    v_score_total INTEGER := 0;
    v_confidence NUMERIC := 1.0;
    v_feature RECORD;
    v_feature_count INTEGER := 0;
    v_weights JSONB;
    v_w_physical NUMERIC := 1.0;
    v_w_mental NUMERIC := 1.0;
    v_w_nutritional NUMERIC := 1.0;
    v_w_social NUMERIC := 1.0;
    v_w_environmental NUMERIC := 1.0;
    v_w_prosperity NUMERIC := 1.0;
BEGIN
    -- Gate 1: authenticated user
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Gate 2: tenant context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'NO_TENANT');
    END IF;

    -- Collect feature inputs
    FOR v_feature IN
        SELECT feature_key, feature_value, confidence
        FROM public.health_features_daily
        WHERE user_id = v_user_id AND tenant_id = v_tenant_id AND date = p_date
    LOOP
        v_feature_inputs := v_feature_inputs || jsonb_build_object(v_feature.feature_key, v_feature.feature_value);
        v_feature_count := v_feature_count + 1;
    END LOOP;

    -- Pillar 1: Physical (heart rate heuristic — unchanged from v1)
    SELECT COALESCE(LEAST(200, GREATEST(0,
        COALESCE((SELECT
            CASE
                WHEN feature_value BETWEEN 60 AND 100 THEN 180
                WHEN feature_value BETWEEN 50 AND 110 THEN 150
                ELSE 100
            END
        FROM public.health_features_daily
        WHERE user_id = v_user_id AND tenant_id = v_tenant_id AND date = p_date
          AND feature_key = 'wearable_heart_rate'), 100)
    )), 100) INTO v_score_physical;

    -- Pillar 2: Mental (stress heuristic — unchanged from v1)
    SELECT COALESCE(LEAST(200, GREATEST(0,
        COALESCE((SELECT
            CASE
                WHEN feature_value < 30 THEN 180
                WHEN feature_value < 50 THEN 150
                WHEN feature_value < 70 THEN 100
                ELSE 50
            END
        FROM public.health_features_daily
        WHERE user_id = v_user_id AND tenant_id = v_tenant_id AND date = p_date
          AND feature_key = 'wearable_stress'), 100)
    )), 100) INTO v_score_mental;

    -- Pillar 3: Nutritional (glucose heuristic — unchanged from v1)
    SELECT COALESCE(LEAST(200, GREATEST(0,
        COALESCE((SELECT
            CASE
                WHEN feature_value BETWEEN 70 AND 100 THEN 180
                WHEN feature_value BETWEEN 60 AND 125 THEN 150
                ELSE 100
            END
        FROM public.health_features_daily
        WHERE user_id = v_user_id AND tenant_id = v_tenant_id AND date = p_date
          AND feature_key = 'biomarker_glucose'), 100)
    )), 100) INTO v_score_nutritional;

    -- Pillar 4: Social — baseline until Proactive Guide Phase 1a wires real signals
    v_score_social := 100;

    -- Pillar 5: Environmental — baseline until Proactive Guide Phase 1b
    v_score_environmental := 100;

    -- Pillar 6: Prosperity — baseline until Proactive Guide Phase 1c
    v_score_prosperity := 100;

    -- Read active config weights (default 1.0 each if no config or missing keys)
    SELECT pillar_weights INTO v_weights
    FROM public.vitana_index_config
    WHERE is_active = TRUE
    ORDER BY version DESC
    LIMIT 1;

    IF v_weights IS NOT NULL THEN
        v_w_physical      := COALESCE((v_weights->>'physical')::NUMERIC, 1.0);
        v_w_mental        := COALESCE((v_weights->>'mental')::NUMERIC, 1.0);
        v_w_nutritional   := COALESCE((v_weights->>'nutritional')::NUMERIC, 1.0);
        v_w_social        := COALESCE((v_weights->>'social')::NUMERIC, 1.0);
        v_w_environmental := COALESCE((v_weights->>'environmental')::NUMERIC, 1.0);
        v_w_prosperity    := COALESCE((v_weights->>'prosperity')::NUMERIC, 1.0);
    END IF;

    -- Total = sum of weighted pillars, clamped to [0, 999]
    v_score_total := LEAST(999, GREATEST(0, ROUND(
          (v_score_physical      * v_w_physical)
        + (v_score_mental        * v_w_mental)
        + (v_score_nutritional   * v_w_nutritional)
        + (v_score_social        * v_w_social)
        + (v_score_environmental * v_w_environmental)
        + (v_score_prosperity    * v_w_prosperity)
    )::INTEGER));

    -- Confidence from feature availability
    IF v_feature_count = 0 THEN
        v_confidence := 0.1;
    ELSIF v_feature_count < 3 THEN
        v_confidence := 0.5;
    ELSE
        v_confidence := 0.9;
    END IF;

    -- Upsert
    INSERT INTO public.vitana_index_scores (
        tenant_id, user_id, date, score_total,
        score_physical, score_mental, score_nutritional,
        score_social, score_environmental, score_prosperity,
        model_version, feature_inputs, confidence
    ) VALUES (
        v_tenant_id, v_user_id, p_date, v_score_total,
        v_score_physical, v_score_mental, v_score_nutritional,
        v_score_social, v_score_environmental, v_score_prosperity,
        p_model_version, v_feature_inputs, v_confidence
    )
    ON CONFLICT (tenant_id, user_id, date) DO UPDATE SET
        score_total = EXCLUDED.score_total,
        score_physical = EXCLUDED.score_physical,
        score_mental = EXCLUDED.score_mental,
        score_nutritional = EXCLUDED.score_nutritional,
        score_social = EXCLUDED.score_social,
        score_environmental = EXCLUDED.score_environmental,
        score_prosperity = EXCLUDED.score_prosperity,
        model_version = EXCLUDED.model_version,
        feature_inputs = EXCLUDED.feature_inputs,
        confidence = EXCLUDED.confidence,
        updated_at = NOW();

    RETURN jsonb_build_object(
        'ok', true,
        'date', p_date,
        'score_total', v_score_total,
        'score_physical', v_score_physical,
        'score_mental', v_score_mental,
        'score_nutritional', v_score_nutritional,
        'score_social', v_score_social,
        'score_environmental', v_score_environmental,
        'score_prosperity', v_score_prosperity,
        'pillar_weights', jsonb_build_object(
            'physical', v_w_physical,
            'mental', v_w_mental,
            'nutritional', v_w_nutritional,
            'social', v_w_social,
            'environmental', v_w_environmental,
            'prosperity', v_w_prosperity
        ),
        'model_version', p_model_version,
        'feature_count', v_feature_count,
        'confidence', v_confidence,
        'tenant_id', v_tenant_id,
        'user_id', v_user_id
    );
END;
$$;

COMMIT;

-- =============================================================================
-- Rollback notes (manual):
--   DROP FUNCTION health_compute_vitana_index(date, text);
--   (then re-apply the original v1 RPC from 20251231000000_vtid_01103_health_compute_engine.sql)
--   ALTER TABLE vitana_index_config DROP COLUMN pillar_weights;
-- =============================================================================
