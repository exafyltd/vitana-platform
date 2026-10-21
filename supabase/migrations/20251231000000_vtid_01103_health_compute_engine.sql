-- Migration: 20251231000000_vtid_01103_health_compute_engine.sql
-- Purpose: VTID-01103 Phase C3: Daily Compute Engine (Features → Vitana Index → Recommendations)
-- Date: 2025-12-31
--
-- Creates:
--   1. Health data tables (wearable_samples, biomarker_results, health_features_daily, vitana_index_scores, recommendations)
--   2. Deterministic compute RPCs:
--      - health_compute_features_daily(p_date date)
--      - health_compute_vitana_index(p_date date, p_model_version text)
--      - health_generate_recommendations(p_from date, p_to date, p_model_version text)

-- ===========================================================================
-- 1. HEALTH DATA TABLES
-- ===========================================================================

-- Wearable Samples: Raw data from wearable devices
CREATE TABLE IF NOT EXISTS public.wearable_samples (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    sample_type TEXT NOT NULL, -- 'heart_rate', 'hrv', 'steps', 'sleep', 'stress', 'spo2', etc.
    value NUMERIC NOT NULL,
    unit TEXT NOT NULL, -- 'bpm', 'ms', 'steps', 'hours', 'percentage', etc.
    recorded_at TIMESTAMPTZ NOT NULL,
    source TEXT, -- 'apple_watch', 'garmin', 'fitbit', 'oura', etc.
    metadata JSONB DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for efficient daily aggregation queries
CREATE INDEX IF NOT EXISTS idx_wearable_samples_tenant_user_date
    ON public.wearable_samples (tenant_id, user_id, DATE(recorded_at), sample_type);

-- Biomarker Results: Lab results and clinical biomarkers
CREATE TABLE IF NOT EXISTS public.biomarker_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    biomarker_type TEXT NOT NULL, -- 'glucose', 'cholesterol', 'hemoglobin', 'cortisol', etc.
    value NUMERIC NOT NULL,
    unit TEXT NOT NULL, -- 'mg/dL', 'mmol/L', 'ng/mL', etc.
    reference_range_low NUMERIC,
    reference_range_high NUMERIC,
    measured_at TIMESTAMPTZ NOT NULL,
    source TEXT, -- 'lab_corp', 'quest', 'home_kit', etc.
    metadata JSONB DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for efficient daily aggregation queries
CREATE INDEX IF NOT EXISTS idx_biomarker_results_tenant_user_date
    ON public.biomarker_results (tenant_id, user_id, DATE(measured_at), biomarker_type);

-- Health Features Daily: Aggregated daily health features (computed from raw data)
CREATE TABLE IF NOT EXISTS public.health_features_daily (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    feature_key TEXT NOT NULL, -- 'avg_heart_rate', 'hrv_rmssd', 'total_steps', 'sleep_hours', etc.
    feature_value NUMERIC NOT NULL,
    feature_unit TEXT, -- 'bpm', 'ms', 'steps', 'hours', etc.
    sample_count INTEGER DEFAULT 0, -- Number of raw samples used
    confidence NUMERIC DEFAULT 1.0, -- 0.0-1.0 confidence score
    metadata JSONB DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT health_features_daily_unique UNIQUE (tenant_id, user_id, date, feature_key)
);

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_health_features_daily_tenant_user_date
    ON public.health_features_daily (tenant_id, user_id, date);

-- Vitana Index Scores: Daily computed health scores (0-999 scale, 5 pillars)
CREATE TABLE IF NOT EXISTS public.vitana_index_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    score_total INTEGER NOT NULL CHECK (score_total >= 0 AND score_total <= 999),
    score_physical INTEGER DEFAULT 0 CHECK (score_physical >= 0 AND score_physical <= 200),
    score_mental INTEGER DEFAULT 0 CHECK (score_mental >= 0 AND score_mental <= 200),
    score_nutritional INTEGER DEFAULT 0 CHECK (score_nutritional >= 0 AND score_nutritional <= 200),
    score_social INTEGER DEFAULT 0 CHECK (score_social >= 0 AND score_social <= 200),
    score_environmental INTEGER DEFAULT 0 CHECK (score_environmental >= 0 AND score_environmental <= 200),
    model_version TEXT NOT NULL DEFAULT 'v1',
    feature_inputs JSONB DEFAULT '{}'::JSONB, -- Features used for this score
    confidence NUMERIC DEFAULT 1.0, -- 0.0-1.0 confidence score
    metadata JSONB DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT vitana_index_scores_unique UNIQUE (tenant_id, user_id, date)
);

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_vitana_index_scores_tenant_user_date
    ON public.vitana_index_scores (tenant_id, user_id, date);

-- Recommendations: AI-generated health recommendations
CREATE TABLE IF NOT EXISTS public.recommendations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    date DATE NOT NULL, -- Date the recommendation applies to
    recommendation_type TEXT NOT NULL, -- 'physical', 'mental', 'nutritional', 'social', 'environmental'
    priority INTEGER DEFAULT 50 CHECK (priority >= 0 AND priority <= 100), -- Higher = more important
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    action_items JSONB DEFAULT '[]'::JSONB, -- Array of specific action items
    related_features JSONB DEFAULT '[]'::JSONB, -- Feature keys that triggered this
    related_score_pillar TEXT, -- Which pillar this recommendation targets
    model_version TEXT NOT NULL DEFAULT 'v1',
    safety_checked BOOLEAN NOT NULL DEFAULT FALSE, -- Must be true before showing to user
    safety_notes TEXT, -- Notes from safety check
    expires_at TIMESTAMPTZ, -- When this recommendation expires
    metadata JSONB DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_recommendations_tenant_user_date
    ON public.recommendations (tenant_id, user_id, date);
CREATE INDEX IF NOT EXISTS idx_recommendations_type
    ON public.recommendations (recommendation_type);

-- ===========================================================================
-- 2. ENABLE RLS ON ALL TABLES
-- ===========================================================================

ALTER TABLE public.wearable_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.biomarker_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_features_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vitana_index_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recommendations ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Users can only access their own data
CREATE POLICY wearable_samples_user_policy ON public.wearable_samples
    FOR ALL USING (user_id = auth.uid());

CREATE POLICY biomarker_results_user_policy ON public.biomarker_results
    FOR ALL USING (user_id = auth.uid());

CREATE POLICY health_features_daily_user_policy ON public.health_features_daily
    FOR ALL USING (user_id = auth.uid());

CREATE POLICY vitana_index_scores_user_policy ON public.vitana_index_scores
    FOR ALL USING (user_id = auth.uid());

CREATE POLICY recommendations_user_policy ON public.recommendations
    FOR ALL USING (user_id = auth.uid());

-- ===========================================================================
-- 3. RPC: health_compute_features_daily(p_date date)
-- ===========================================================================
-- Aggregates from wearable_samples + biomarker_results into health_features_daily
-- Uses current_tenant_id/current_user_id from request context
-- Returns {ok:true, date, upserted_count}

CREATE OR REPLACE FUNCTION public.health_compute_features_daily(p_date DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_upserted_count INTEGER := 0;
    v_feature RECORD;
BEGIN
    -- Gate 1: Get authenticated user
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Gate 2: Get tenant_id
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'NO_TENANT',
            'message', 'No tenant context'
        );
    END IF;

    -- Aggregate wearable samples for the date
    FOR v_feature IN
        SELECT
            sample_type as feature_key,
            AVG(value) as avg_value,
            COUNT(*) as sample_count,
            CASE
                WHEN sample_type = 'heart_rate' THEN 'bpm'
                WHEN sample_type = 'hrv' THEN 'ms'
                WHEN sample_type = 'steps' THEN 'steps'
                WHEN sample_type = 'sleep' THEN 'hours'
                WHEN sample_type = 'stress' THEN 'index'
                WHEN sample_type = 'spo2' THEN 'percentage'
                ELSE 'unit'
            END as feature_unit
        FROM public.wearable_samples
        WHERE user_id = v_user_id
            AND tenant_id = v_tenant_id
            AND DATE(recorded_at) = p_date
        GROUP BY sample_type
    LOOP
        INSERT INTO public.health_features_daily (
            tenant_id, user_id, date, feature_key,
            feature_value, feature_unit, sample_count, confidence
        )
        VALUES (
            v_tenant_id, v_user_id, p_date, 'wearable_' || v_feature.feature_key,
            v_feature.avg_value, v_feature.feature_unit, v_feature.sample_count, 1.0
        )
        ON CONFLICT (tenant_id, user_id, date, feature_key)
        DO UPDATE SET
            feature_value = EXCLUDED.feature_value,
            feature_unit = EXCLUDED.feature_unit,
            sample_count = EXCLUDED.sample_count,
            updated_at = NOW();

        v_upserted_count := v_upserted_count + 1;
    END LOOP;

    -- Aggregate biomarker results for the date
    FOR v_feature IN
        SELECT
            biomarker_type as feature_key,
            AVG(value) as avg_value,
            COUNT(*) as sample_count,
            MIN(unit) as feature_unit -- Use first unit (should all be same)
        FROM public.biomarker_results
        WHERE user_id = v_user_id
            AND tenant_id = v_tenant_id
            AND DATE(measured_at) = p_date
        GROUP BY biomarker_type
    LOOP
        INSERT INTO public.health_features_daily (
            tenant_id, user_id, date, feature_key,
            feature_value, feature_unit, sample_count, confidence
        )
        VALUES (
            v_tenant_id, v_user_id, p_date, 'biomarker_' || v_feature.feature_key,
            v_feature.avg_value, v_feature.feature_unit, v_feature.sample_count, 1.0
        )
        ON CONFLICT (tenant_id, user_id, date, feature_key)
        DO UPDATE SET
            feature_value = EXCLUDED.feature_value,
            feature_unit = EXCLUDED.feature_unit,
            sample_count = EXCLUDED.sample_count,
            updated_at = NOW();

        v_upserted_count := v_upserted_count + 1;
    END LOOP;

    RETURN jsonb_build_object(
        'ok', true,
        'date', p_date,
        'upserted_count', v_upserted_count,
        'tenant_id', v_tenant_id,
        'user_id', v_user_id
    );
END;
$$;

-- ===========================================================================
-- 4. RPC: health_compute_vitana_index(p_date date, p_model_version text)
-- ===========================================================================
-- Computes vitana_index_scores for the date using health_features_daily
-- Uses current_tenant_id/current_user_id from request context
-- Returns {ok:true, date, score_total, model_version}

CREATE OR REPLACE FUNCTION public.health_compute_vitana_index(
    p_date DATE,
    p_model_version TEXT DEFAULT 'v1'
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
    v_score_physical INTEGER := 0;
    v_score_mental INTEGER := 0;
    v_score_nutritional INTEGER := 0;
    v_score_social INTEGER := 0;
    v_score_environmental INTEGER := 0;
    v_score_total INTEGER := 0;
    v_confidence NUMERIC := 1.0;
    v_feature RECORD;
    v_feature_count INTEGER := 0;
BEGIN
    -- Gate 1: Get authenticated user
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Gate 2: Get tenant_id
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'NO_TENANT',
            'message', 'No tenant context'
        );
    END IF;

    -- Collect features for the date
    FOR v_feature IN
        SELECT feature_key, feature_value, confidence
        FROM public.health_features_daily
        WHERE user_id = v_user_id
            AND tenant_id = v_tenant_id
            AND date = p_date
    LOOP
        v_feature_inputs := v_feature_inputs || jsonb_build_object(
            v_feature.feature_key, v_feature.feature_value
        );
        v_feature_count := v_feature_count + 1;
    END LOOP;

    -- Compute pillar scores (deterministic v1 model)
    -- Physical: Based on heart rate, steps, sleep, HRV
    SELECT COALESCE(
        (SELECT LEAST(200, GREATEST(0,
            -- Heart rate: 60-100 is good, scale 0-200
            COALESCE((SELECT
                CASE
                    WHEN feature_value BETWEEN 60 AND 100 THEN 180
                    WHEN feature_value BETWEEN 50 AND 110 THEN 150
                    ELSE 100
                END
            FROM public.health_features_daily
            WHERE user_id = v_user_id AND tenant_id = v_tenant_id AND date = p_date
            AND feature_key = 'wearable_heart_rate'), 100)
            -- Add more physical features here
        ))
        ), 100) INTO v_score_physical;

    -- Mental: Based on stress, HRV (proxy for parasympathetic activity)
    SELECT COALESCE(
        (SELECT LEAST(200, GREATEST(0,
            COALESCE((SELECT
                CASE
                    WHEN feature_value < 30 THEN 180  -- Low stress is good
                    WHEN feature_value < 50 THEN 150
                    WHEN feature_value < 70 THEN 100
                    ELSE 50
                END
            FROM public.health_features_daily
            WHERE user_id = v_user_id AND tenant_id = v_tenant_id AND date = p_date
            AND feature_key = 'wearable_stress'), 100)
        ))
        ), 100) INTO v_score_mental;

    -- Nutritional: Based on glucose and other biomarkers
    SELECT COALESCE(
        (SELECT LEAST(200, GREATEST(0,
            COALESCE((SELECT
                CASE
                    WHEN feature_value BETWEEN 70 AND 100 THEN 180  -- Normal fasting glucose
                    WHEN feature_value BETWEEN 60 AND 125 THEN 150
                    ELSE 100
                END
            FROM public.health_features_daily
            WHERE user_id = v_user_id AND tenant_id = v_tenant_id AND date = p_date
            AND feature_key = 'biomarker_glucose'), 100)
        ))
        ), 100) INTO v_score_nutritional;

    -- Social: Baseline score (requires external data)
    v_score_social := 100;

    -- Environmental: Baseline score (requires external data)
    v_score_environmental := 100;

    -- Calculate total (0-999 scale)
    v_score_total := LEAST(999, v_score_physical + v_score_mental + v_score_nutritional + v_score_social + v_score_environmental);

    -- Calculate confidence based on feature availability
    IF v_feature_count = 0 THEN
        v_confidence := 0.1;  -- Very low confidence with no features
    ELSIF v_feature_count < 3 THEN
        v_confidence := 0.5;  -- Medium confidence
    ELSE
        v_confidence := 0.9;  -- High confidence
    END IF;

    -- Upsert the score
    INSERT INTO public.vitana_index_scores (
        tenant_id, user_id, date, score_total,
        score_physical, score_mental, score_nutritional, score_social, score_environmental,
        model_version, feature_inputs, confidence
    )
    VALUES (
        v_tenant_id, v_user_id, p_date, v_score_total,
        v_score_physical, v_score_mental, v_score_nutritional, v_score_social, v_score_environmental,
        p_model_version, v_feature_inputs, v_confidence
    )
    ON CONFLICT (tenant_id, user_id, date)
    DO UPDATE SET
        score_total = EXCLUDED.score_total,
        score_physical = EXCLUDED.score_physical,
        score_mental = EXCLUDED.score_mental,
        score_nutritional = EXCLUDED.score_nutritional,
        score_social = EXCLUDED.score_social,
        score_environmental = EXCLUDED.score_environmental,
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
        'model_version', p_model_version,
        'feature_count', v_feature_count,
        'confidence', v_confidence,
        'tenant_id', v_tenant_id,
        'user_id', v_user_id
    );
END;
$$;

-- ===========================================================================
-- 5. RPC: health_generate_recommendations(p_from date, p_to date, p_model_version text)
-- ===========================================================================
-- Deterministically generates recommendations into recommendations table
-- Safe-by-default: sets safety_checked=false initially
-- Uses current_tenant_id/current_user_id from request context
-- Returns {ok:true, created_count}

CREATE OR REPLACE FUNCTION public.health_generate_recommendations(
    p_from DATE,
    p_to DATE,
    p_model_version TEXT DEFAULT 'v1'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_created_count INTEGER := 0;
    v_score RECORD;
    v_rec_id UUID;
BEGIN
    -- Gate 1: Get authenticated user
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Gate 2: Get tenant_id
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'NO_TENANT',
            'message', 'No tenant context'
        );
    END IF;

    -- Generate recommendations based on vitana index scores
    FOR v_score IN
        SELECT * FROM public.vitana_index_scores
        WHERE user_id = v_user_id
            AND tenant_id = v_tenant_id
            AND date BETWEEN p_from AND p_to
    LOOP
        -- Physical recommendation if score is low
        IF v_score.score_physical < 150 THEN
            INSERT INTO public.recommendations (
                tenant_id, user_id, date, recommendation_type, priority,
                title, description, action_items, related_score_pillar,
                model_version, safety_checked, expires_at
            )
            VALUES (
                v_tenant_id, v_user_id, v_score.date, 'physical', 70,
                'Improve Physical Activity',
                'Your physical wellness score indicates room for improvement. Consider increasing your daily activity level.',
                '["Take a 30-minute walk today", "Try light stretching exercises", "Consider a short workout routine"]'::JSONB,
                'physical',
                p_model_version, FALSE, v_score.date + INTERVAL '7 days'
            )
            ON CONFLICT DO NOTHING;
            v_created_count := v_created_count + 1;
        END IF;

        -- Mental recommendation if score is low
        IF v_score.score_mental < 150 THEN
            INSERT INTO public.recommendations (
                tenant_id, user_id, date, recommendation_type, priority,
                title, description, action_items, related_score_pillar,
                model_version, safety_checked, expires_at
            )
            VALUES (
                v_tenant_id, v_user_id, v_score.date, 'mental', 75,
                'Focus on Mental Wellness',
                'Your stress indicators suggest elevated stress levels. Consider stress-reduction activities.',
                '["Practice 5 minutes of deep breathing", "Take short breaks during work", "Consider a brief meditation session"]'::JSONB,
                'mental',
                p_model_version, FALSE, v_score.date + INTERVAL '7 days'
            )
            ON CONFLICT DO NOTHING;
            v_created_count := v_created_count + 1;
        END IF;

        -- Nutritional recommendation if score is low
        IF v_score.score_nutritional < 150 THEN
            INSERT INTO public.recommendations (
                tenant_id, user_id, date, recommendation_type, priority,
                title, description, action_items, related_score_pillar,
                model_version, safety_checked, expires_at
            )
            VALUES (
                v_tenant_id, v_user_id, v_score.date, 'nutritional', 65,
                'Review Nutritional Habits',
                'Your nutritional markers could benefit from attention. Consider reviewing your dietary habits.',
                '["Stay hydrated throughout the day", "Include more vegetables in meals", "Maintain regular meal times"]'::JSONB,
                'nutritional',
                p_model_version, FALSE, v_score.date + INTERVAL '7 days'
            )
            ON CONFLICT DO NOTHING;
            v_created_count := v_created_count + 1;
        END IF;

        -- General wellness recommendation for low overall score
        IF v_score.score_total < 500 THEN
            INSERT INTO public.recommendations (
                tenant_id, user_id, date, recommendation_type, priority,
                title, description, action_items, related_score_pillar,
                model_version, safety_checked, expires_at
            )
            VALUES (
                v_tenant_id, v_user_id, v_score.date, 'physical', 80,
                'Prioritize Overall Wellness',
                'Your overall Vitana Index suggests focusing on foundational health habits.',
                '["Ensure 7-8 hours of quality sleep", "Take regular movement breaks", "Connect with friends or family"]'::JSONB,
                NULL,
                p_model_version, FALSE, v_score.date + INTERVAL '7 days'
            )
            ON CONFLICT DO NOTHING;
            v_created_count := v_created_count + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'ok', true,
        'created_count', v_created_count,
        'date_from', p_from,
        'date_to', p_to,
        'model_version', p_model_version,
        'tenant_id', v_tenant_id,
        'user_id', v_user_id
    );
END;
$$;

-- ===========================================================================
-- 6. PERMISSIONS
-- ===========================================================================

-- Grant execute on RPCs to authenticated users
GRANT EXECUTE ON FUNCTION public.health_compute_features_daily(DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.health_compute_vitana_index(DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.health_generate_recommendations(DATE, DATE, TEXT) TO authenticated;

-- Grant table access for RLS policies (service role will bypass, user queries go through RLS)
GRANT SELECT, INSERT, UPDATE ON public.wearable_samples TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.biomarker_results TO authenticated;
GRANT SELECT ON public.health_features_daily TO authenticated;
GRANT SELECT ON public.vitana_index_scores TO authenticated;
GRANT SELECT ON public.recommendations TO authenticated;

-- ===========================================================================
-- 7. COMMENTS
-- ===========================================================================

COMMENT ON TABLE public.wearable_samples IS 'VTID-01103: Raw wearable device data samples (heart rate, HRV, steps, sleep, etc.)';
COMMENT ON TABLE public.biomarker_results IS 'VTID-01103: Lab biomarker results (glucose, cholesterol, etc.)';
COMMENT ON TABLE public.health_features_daily IS 'VTID-01103: Aggregated daily health features computed from raw data';
COMMENT ON TABLE public.vitana_index_scores IS 'VTID-01103: Daily Vitana Index scores (0-999 scale, 5 pillars)';
COMMENT ON TABLE public.recommendations IS 'VTID-01103: AI-generated health recommendations (safety_checked=false by default)';

COMMENT ON FUNCTION public.health_compute_features_daily IS 'VTID-01103: Aggregates wearable_samples + biomarker_results into health_features_daily. Idempotent.';
COMMENT ON FUNCTION public.health_compute_vitana_index IS 'VTID-01103: Computes Vitana Index scores from health_features_daily. Idempotent.';
COMMENT ON FUNCTION public.health_generate_recommendations IS 'VTID-01103: Generates recommendations based on Vitana Index scores. Safe-by-default (safety_checked=false).';
