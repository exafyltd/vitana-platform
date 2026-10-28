-- Migration: 20260103000000_vtid_01145_overload_detection.sql
-- Purpose: VTID-01145 D51 Predictive Fatigue, Burnout & Overload Detection Engine
-- Date: 2026-01-03
--
-- Detects early patterns of fatigue, cognitive overload, emotional strain, or
-- burnout risk BEFORE they escalate, and surfaces them as gentle awareness signals.
--
-- This engine answers: "Is the system observing early signs of overload — and why?"
--
-- Dependencies:
--   - VTID-01101 (Phase A-Fix) - tenant/user/role helpers
--   - VTID-01102 (Phase B-Fix) - runtime context bridge
--   - VTID-01137 (D43 Longitudinal) - trend data
--   - VTID-01122 (D37 Health Capacity) - capacity signals
--   - VTID-01120 (D28 Emotional/Cognitive) - emotional/cognitive signals
--
-- Hard Constraints (from spec):
--   - Memory-first: All outputs logged to OASIS
--   - Safety-first: No medical or psychological diagnosis
--   - Detection ≠ labeling: No diagnostic terms
--   - No urgency or alarm framing
--   - Explainability mandatory
--   - Always dismissible

-- ===========================================================================
-- 1. overload_detections (Primary detection records)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.overload_detections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,

    -- Primary dimension (exactly one)
    dimension TEXT NOT NULL
        CHECK (dimension IN ('physical', 'cognitive', 'emotional', 'routine', 'social', 'context')),

    -- Confidence score (must be >= 75 to emit)
    confidence INT NOT NULL DEFAULT 0
        CHECK (confidence >= 0 AND confidence <= 100),

    -- Time window of detection
    time_window TEXT NOT NULL DEFAULT 'last_14_days'
        CHECK (time_window IN ('last_7_days', 'last_14_days', 'last_21_days')),

    -- Referenced patterns (array of pattern references, min 2)
    observed_patterns TEXT[] NOT NULL DEFAULT '{}',

    -- Full pattern details (JSONB for flexibility)
    pattern_details JSONB NOT NULL DEFAULT '[]'::JSONB,
    -- Format: [{ "pattern_type": "...", "signal_sources": [...],
    --            "first_observed_at": "...", "observation_count": N,
    --            "intensity": 0-100, "trend_direction": "...",
    --            "supporting_evidence": "..." }]

    -- Baseline deviation info
    baseline_deviation JSONB NULL,
    -- Format: { "dimension": "...", "baseline_score": N, "current_score": N,
    --           "deviation_magnitude": N, "deviation_percentage": N,
    --           "is_significant": true/false, "significance_threshold": N }

    -- Impact assessment
    potential_impact TEXT NOT NULL DEFAULT 'low'
        CHECK (potential_impact IN ('low', 'medium', 'high')),

    -- Plain language explanation (observational, non-diagnostic)
    explainability_text TEXT NOT NULL,

    -- Always true - user can always dismiss
    dismissible BOOLEAN NOT NULL DEFAULT true,

    -- Dismissal tracking
    dismissed_at TIMESTAMPTZ NULL,
    dismissed_reason TEXT NULL,

    -- Non-clinical disclaimer (always present)
    disclaimer TEXT NOT NULL DEFAULT 'These observations are pattern-based awareness signals, not medical or psychological assessments. They reflect system observations that may be dismissed at any time.',

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Soft delete
    deleted_at TIMESTAMPTZ NULL
);

-- Index for user detection lookups
CREATE INDEX IF NOT EXISTS idx_overload_detections_user
    ON public.overload_detections (tenant_id, user_id, created_at DESC)
    WHERE deleted_at IS NULL;

-- Index for active (non-dismissed) detections
CREATE INDEX IF NOT EXISTS idx_overload_detections_active
    ON public.overload_detections (tenant_id, user_id, dismissed_at)
    WHERE deleted_at IS NULL AND dismissed_at IS NULL;

-- Index for dimension-based queries
CREATE INDEX IF NOT EXISTS idx_overload_detections_dimension
    ON public.overload_detections (tenant_id, user_id, dimension, created_at DESC)
    WHERE deleted_at IS NULL;

-- ===========================================================================
-- 2. overload_baselines (User baseline snapshots for comparison)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.overload_baselines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,

    -- Dimension this baseline is for
    dimension TEXT NOT NULL
        CHECK (dimension IN ('physical', 'cognitive', 'emotional', 'routine', 'social', 'context')),

    -- Baseline score (0-100)
    baseline_score INT NOT NULL DEFAULT 50
        CHECK (baseline_score >= 0 AND baseline_score <= 100),

    -- How many data points contributed
    data_points_count INT NOT NULL DEFAULT 0,

    -- Standard deviation for significance calculation
    standard_deviation NUMERIC(10, 4) NOT NULL DEFAULT 0,

    -- Is this baseline stable enough for comparison?
    is_stable BOOLEAN NOT NULL DEFAULT false,

    -- When this baseline was computed
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- When this baseline expires (recompute needed)
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',

    -- Unique constraint per user+dimension
    CONSTRAINT overload_baselines_unique
        UNIQUE NULLS NOT DISTINCT (tenant_id, user_id, dimension)
);

-- Index for baseline lookups
CREATE INDEX IF NOT EXISTS idx_overload_baselines_user
    ON public.overload_baselines (tenant_id, user_id, dimension);

-- ===========================================================================
-- 3. overload_patterns (Observed pattern history for detection)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.overload_patterns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,

    -- Pattern type
    pattern_type TEXT NOT NULL
        CHECK (pattern_type IN (
            'sustained_low_energy', 'cognitive_decline', 'emotional_volatility',
            'routine_rigidity', 'social_withdrawal', 'context_thrashing',
            'recovery_deficit', 'capacity_erosion', 'engagement_drop', 'stress_accumulation'
        )),

    -- Primary dimension affected
    dimension TEXT NOT NULL
        CHECK (dimension IN ('physical', 'cognitive', 'emotional', 'routine', 'social', 'context')),

    -- Signal sources that contributed
    signal_sources TEXT[] NOT NULL DEFAULT '{}',

    -- When first observed
    first_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- How many times observed
    observation_count INT NOT NULL DEFAULT 1,

    -- Pattern intensity (0-100)
    intensity INT NOT NULL DEFAULT 50
        CHECK (intensity >= 0 AND intensity <= 100),

    -- Trend direction
    trend_direction TEXT NOT NULL DEFAULT 'stable'
        CHECK (trend_direction IN ('worsening', 'stable', 'improving')),

    -- Supporting evidence
    supporting_evidence TEXT NULL,

    -- Last updated
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Soft delete
    deleted_at TIMESTAMPTZ NULL
);

-- Index for pattern lookups
CREATE INDEX IF NOT EXISTS idx_overload_patterns_user
    ON public.overload_patterns (tenant_id, user_id, dimension, created_at DESC)
    WHERE deleted_at IS NULL;

-- Index for pattern type lookups
CREATE INDEX IF NOT EXISTS idx_overload_patterns_type
    ON public.overload_patterns (tenant_id, user_id, pattern_type, first_observed_at DESC)
    WHERE deleted_at IS NULL;

-- Add created_at column (for index)
ALTER TABLE public.overload_patterns
ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ===========================================================================
-- 4. Enable RLS on tables
-- ===========================================================================

ALTER TABLE public.overload_detections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.overload_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.overload_patterns ENABLE ROW LEVEL SECURITY;

-- overload_detections RLS
DROP POLICY IF EXISTS overload_detections_select ON public.overload_detections;
CREATE POLICY overload_detections_select ON public.overload_detections
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS overload_detections_insert ON public.overload_detections;
CREATE POLICY overload_detections_insert ON public.overload_detections
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS overload_detections_update ON public.overload_detections;
CREATE POLICY overload_detections_update ON public.overload_detections
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid())
    WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

-- overload_baselines RLS
DROP POLICY IF EXISTS overload_baselines_select ON public.overload_baselines;
CREATE POLICY overload_baselines_select ON public.overload_baselines
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS overload_baselines_insert ON public.overload_baselines;
CREATE POLICY overload_baselines_insert ON public.overload_baselines
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS overload_baselines_update ON public.overload_baselines;
CREATE POLICY overload_baselines_update ON public.overload_baselines
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid())
    WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

-- overload_patterns RLS
DROP POLICY IF EXISTS overload_patterns_select ON public.overload_patterns;
CREATE POLICY overload_patterns_select ON public.overload_patterns
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS overload_patterns_insert ON public.overload_patterns;
CREATE POLICY overload_patterns_insert ON public.overload_patterns
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS overload_patterns_update ON public.overload_patterns;
CREATE POLICY overload_patterns_update ON public.overload_patterns
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid())
    WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

-- ===========================================================================
-- 5. RPC: overload_compute_baselines()
-- Compute user baselines for all dimensions
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.overload_compute_baselines(
    p_dimensions TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_dimension TEXT;
    v_dimensions TEXT[];
    v_baselines JSONB := '[]'::JSONB;
    v_baseline_row RECORD;
    v_data_points RECORD;
    v_avg_score NUMERIC;
    v_std_dev NUMERIC;
    v_count INT;
    v_is_stable BOOLEAN;
BEGIN
    -- Gate 1: Get tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TENANT_NOT_FOUND',
            'message', 'Unable to determine tenant_id from request context'
        );
    END IF;

    -- Gate 2: Get user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Determine dimensions to compute
    IF p_dimensions IS NOT NULL THEN
        v_dimensions := p_dimensions;
    ELSE
        v_dimensions := ARRAY['physical', 'cognitive', 'emotional', 'routine', 'social', 'context'];
    END IF;

    -- Compute baseline for each dimension
    FOREACH v_dimension IN ARRAY v_dimensions
    LOOP
        -- Get capacity data for this dimension over last 30 days
        SELECT
            AVG(CASE v_dimension
                WHEN 'physical' THEN capacity_physical
                WHEN 'cognitive' THEN capacity_cognitive
                WHEN 'emotional' THEN capacity_emotional
                ELSE (capacity_physical + capacity_cognitive + capacity_emotional) / 3
            END) as avg_score,
            STDDEV_SAMP(CASE v_dimension
                WHEN 'physical' THEN capacity_physical
                WHEN 'cognitive' THEN capacity_cognitive
                WHEN 'emotional' THEN capacity_emotional
                ELSE (capacity_physical + capacity_cognitive + capacity_emotional) / 3
            END) as std_dev,
            COUNT(*) as cnt
        INTO v_data_points
        FROM public.capacity_state
        WHERE tenant_id = v_tenant_id
          AND user_id = v_user_id
          AND created_at >= NOW() - INTERVAL '30 days'
          AND decayed = false;

        v_avg_score := COALESCE(v_data_points.avg_score, 50);
        v_std_dev := COALESCE(v_data_points.std_dev, 15);
        v_count := COALESCE(v_data_points.cnt, 0);

        -- Determine if baseline is stable (enough data points and low variance)
        v_is_stable := v_count >= 14 AND v_std_dev < 25;

        -- Upsert baseline
        INSERT INTO public.overload_baselines (
            tenant_id, user_id, dimension, baseline_score,
            data_points_count, standard_deviation, is_stable,
            computed_at, expires_at
        ) VALUES (
            v_tenant_id, v_user_id, v_dimension, v_avg_score::INT,
            v_count, v_std_dev, v_is_stable,
            NOW(), NOW() + INTERVAL '7 days'
        )
        ON CONFLICT (tenant_id, user_id, dimension)
        DO UPDATE SET
            baseline_score = EXCLUDED.baseline_score,
            data_points_count = EXCLUDED.data_points_count,
            standard_deviation = EXCLUDED.standard_deviation,
            is_stable = EXCLUDED.is_stable,
            computed_at = EXCLUDED.computed_at,
            expires_at = EXCLUDED.expires_at;

        -- Add to result
        v_baselines := v_baselines || jsonb_build_object(
            'dimension', v_dimension,
            'baseline_score', v_avg_score::INT,
            'data_points_count', v_count,
            'standard_deviation', ROUND(v_std_dev::NUMERIC, 2),
            'is_stable', v_is_stable,
            'baseline_computed_at', NOW()
        );
    END LOOP;

    RETURN jsonb_build_object(
        'ok', true,
        'baselines', v_baselines,
        'computed_at', NOW()
    );
END;
$$;

-- ===========================================================================
-- 6. RPC: overload_get_baselines()
-- Get current user baselines
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.overload_get_baselines(
    p_dimensions TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_baselines JSONB;
BEGIN
    -- Gate 1: Get tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TENANT_NOT_FOUND',
            'message', 'Unable to determine tenant_id from request context'
        );
    END IF;

    -- Gate 2: Get user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Get baselines
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'dimension', dimension,
        'baseline_score', baseline_score,
        'data_points_count', data_points_count,
        'standard_deviation', ROUND(standard_deviation::NUMERIC, 2),
        'is_stable', is_stable,
        'baseline_computed_at', computed_at
    )), '[]'::JSONB)
    INTO v_baselines
    FROM public.overload_baselines
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND (p_dimensions IS NULL OR dimension = ANY(p_dimensions));

    RETURN jsonb_build_object(
        'ok', true,
        'baselines', v_baselines
    );
END;
$$;

-- ===========================================================================
-- 7. RPC: overload_detect()
-- Main detection function - analyzes patterns and creates detections
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.overload_detect(
    p_time_window_days INT DEFAULT 14,
    p_dimensions TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_dimensions TEXT[];
    v_dimension TEXT;
    v_cutoff_date TIMESTAMPTZ;
    v_detections JSONB := '[]'::JSONB;
    v_patterns_observed JSONB := '[]'::JSONB;
    v_baseline RECORD;
    v_current_score INT;
    v_deviation_pct NUMERIC;
    v_pattern_count INT;
    v_signal_sources TEXT[];
    v_confidence INT;
    v_potential_impact TEXT;
    v_should_detect BOOLEAN;
    v_detection_id UUID;
    v_explainability TEXT;
    v_time_window TEXT;
    v_patterns_array TEXT[];
    v_pattern_details JSONB;
BEGIN
    -- Gate 1: Get tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TENANT_NOT_FOUND',
            'message', 'Unable to determine tenant_id from request context'
        );
    END IF;

    -- Gate 2: Get user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Clamp time window
    p_time_window_days := GREATEST(7, LEAST(21, p_time_window_days));
    v_cutoff_date := NOW() - (p_time_window_days || ' days')::INTERVAL;

    -- Determine time window label
    CASE
        WHEN p_time_window_days <= 7 THEN v_time_window := 'last_7_days';
        WHEN p_time_window_days <= 14 THEN v_time_window := 'last_14_days';
        ELSE v_time_window := 'last_21_days';
    END CASE;

    -- Determine dimensions to analyze
    IF p_dimensions IS NOT NULL THEN
        v_dimensions := p_dimensions;
    ELSE
        v_dimensions := ARRAY['physical', 'cognitive', 'emotional', 'routine', 'social', 'context'];
    END IF;

    -- Ensure baselines are computed
    PERFORM public.overload_compute_baselines(v_dimensions);

    -- Analyze each dimension
    FOREACH v_dimension IN ARRAY v_dimensions
    LOOP
        -- Get baseline for this dimension
        SELECT * INTO v_baseline
        FROM public.overload_baselines
        WHERE tenant_id = v_tenant_id
          AND user_id = v_user_id
          AND dimension = v_dimension;

        IF v_baseline IS NULL OR NOT v_baseline.is_stable THEN
            -- Not enough data for stable baseline, skip
            CONTINUE;
        END IF;

        -- Get current capacity state for this dimension
        SELECT CASE v_dimension
            WHEN 'physical' THEN capacity_physical
            WHEN 'cognitive' THEN capacity_cognitive
            WHEN 'emotional' THEN capacity_emotional
            ELSE (capacity_physical + capacity_cognitive + capacity_emotional) / 3
        END
        INTO v_current_score
        FROM public.capacity_state
        WHERE tenant_id = v_tenant_id
          AND user_id = v_user_id
          AND decayed = false
        ORDER BY created_at DESC
        LIMIT 1;

        IF v_current_score IS NULL THEN
            v_current_score := 50; -- Default
        END IF;

        -- Calculate deviation from baseline
        v_deviation_pct := CASE
            WHEN v_baseline.baseline_score > 0 THEN
                ((v_baseline.baseline_score - v_current_score)::NUMERIC / v_baseline.baseline_score) * 100
            ELSE 0
        END;

        -- Count observed patterns for this dimension
        SELECT COUNT(*), ARRAY_AGG(DISTINCT unnest) as sources
        INTO v_pattern_count, v_signal_sources
        FROM public.overload_patterns,
             LATERAL unnest(signal_sources) as unnest
        WHERE tenant_id = v_tenant_id
          AND user_id = v_user_id
          AND dimension = v_dimension
          AND deleted_at IS NULL
          AND first_observed_at >= v_cutoff_date;

        v_pattern_count := COALESCE(v_pattern_count, 0);
        v_signal_sources := COALESCE(v_signal_sources, ARRAY[]::TEXT[]);

        -- Get pattern details
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'pattern_type', pattern_type,
            'signal_sources', signal_sources,
            'first_observed_at', first_observed_at,
            'observation_count', observation_count,
            'intensity', intensity,
            'trend_direction', trend_direction,
            'supporting_evidence', supporting_evidence
        )), '[]'::JSONB),
        COALESCE(ARRAY_AGG(pattern_type), ARRAY[]::TEXT[])
        INTO v_pattern_details, v_patterns_array
        FROM public.overload_patterns
        WHERE tenant_id = v_tenant_id
          AND user_id = v_user_id
          AND dimension = v_dimension
          AND deleted_at IS NULL
          AND first_observed_at >= v_cutoff_date;

        -- Add to patterns observed
        v_patterns_observed := v_patterns_observed || v_pattern_details;

        -- Determine if detection criteria are met
        -- Criteria: >= 2 signal sources, deviation >= 20%, pattern >= 7 days OR >= 3 spikes
        v_should_detect := false;
        v_confidence := 0;

        IF array_length(v_signal_sources, 1) >= 2
           AND v_deviation_pct >= 20
           AND v_pattern_count >= 1 THEN
            -- Calculate confidence based on data quality
            v_confidence := LEAST(100,
                50 +
                (CASE WHEN v_baseline.is_stable THEN 20 ELSE 0 END) +
                (CASE WHEN array_length(v_signal_sources, 1) >= 3 THEN 15 ELSE 0 END) +
                (CASE WHEN v_deviation_pct >= 30 THEN 10 ELSE 0 END) +
                (CASE WHEN v_pattern_count >= 2 THEN 10 ELSE 0 END)
            );

            IF v_confidence >= 75 THEN
                v_should_detect := true;
            END IF;
        END IF;

        -- Determine impact level
        IF v_deviation_pct >= 60 THEN
            v_potential_impact := 'high';
        ELSIF v_deviation_pct >= 40 THEN
            v_potential_impact := 'medium';
        ELSE
            v_potential_impact := 'low';
        END IF;

        -- Create detection if criteria met
        IF v_should_detect AND array_length(v_patterns_array, 1) >= 2 THEN
            -- Build explainability text
            v_explainability := CASE v_dimension
                WHEN 'physical' THEN
                    'The system notices patterns that may suggest physical tiredness has been present over the past few weeks. ' ||
                    'This observation is based on energy-related signals and activity patterns (' ||
                    array_length(v_signal_sources, 1) || ' signal sources). ' ||
                    'This is a normal fluctuation that many people experience. It may naturally improve with rest.'
                WHEN 'cognitive' THEN
                    'The system notices patterns that may suggest increased mental load over recent days. ' ||
                    'This observation is based on focus-related signals and task completion patterns (' ||
                    array_length(v_signal_sources, 1) || ' signal sources). ' ||
                    'Periods of higher cognitive demand are common. Lighter tasks may feel more comfortable for now.'
                WHEN 'emotional' THEN
                    'The system notices patterns that may suggest emotional capacity has been stretched recently. ' ||
                    'This observation is based on interaction patterns and emotional signal indicators (' ||
                    array_length(v_signal_sources, 1) || ' signal sources). ' ||
                    'Emotional ebbs and flows are part of life. This observation is temporary and dismissible.'
                WHEN 'routine' THEN
                    'The system notices patterns suggesting routines may be feeling more demanding than usual. ' ||
                    'This observation is based on schedule density and routine completion patterns (' ||
                    array_length(v_signal_sources, 1) || ' signal sources). ' ||
                    'Routine fatigue is common and often resolves with small adjustments.'
                WHEN 'social' THEN
                    'The system notices patterns that may suggest social energy has been more depleted recently. ' ||
                    'This observation is based on social interaction patterns and engagement signals (' ||
                    array_length(v_signal_sources, 1) || ' signal sources). ' ||
                    'Social energy naturally fluctuates. Quiet time often helps restore balance.'
                WHEN 'context' THEN
                    'The system notices patterns suggesting frequent context switching may be present. ' ||
                    'This observation is based on task transition patterns and focus disruption signals (' ||
                    array_length(v_signal_sources, 1) || ' signal sources). ' ||
                    'Context switching load is common in busy periods and tends to normalize.'
                ELSE
                    'The system notices patterns that may suggest capacity has been stretched recently.'
            END;

            -- Insert detection
            INSERT INTO public.overload_detections (
                tenant_id, user_id, dimension, confidence, time_window,
                observed_patterns, pattern_details, baseline_deviation,
                potential_impact, explainability_text, dismissible
            ) VALUES (
                v_tenant_id, v_user_id, v_dimension, v_confidence, v_time_window,
                v_patterns_array, v_pattern_details,
                jsonb_build_object(
                    'dimension', v_dimension,
                    'baseline_score', v_baseline.baseline_score,
                    'current_score', v_current_score,
                    'deviation_magnitude', v_baseline.baseline_score - v_current_score,
                    'deviation_percentage', ROUND(v_deviation_pct::NUMERIC, 1),
                    'is_significant', v_deviation_pct >= 20,
                    'significance_threshold', 20
                ),
                v_potential_impact, v_explainability, true
            )
            RETURNING id INTO v_detection_id;

            -- Add to detections result
            v_detections := v_detections || jsonb_build_object(
                'overload_id', v_detection_id,
                'dimension', v_dimension,
                'confidence', v_confidence,
                'time_window', v_time_window,
                'observed_patterns', v_patterns_array,
                'potential_impact', v_potential_impact,
                'explainability_text', v_explainability,
                'dismissible', true,
                'created_at', NOW(),
                'updated_at', NOW()
            );
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'ok', true,
        'detections', v_detections,
        'patterns_observed', v_patterns_observed,
        'detection_count', jsonb_array_length(v_detections)
    );
END;
$$;

-- ===========================================================================
-- 8. RPC: overload_get_detections()
-- Get current active detections
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.overload_get_detections(
    p_include_dismissed BOOLEAN DEFAULT false,
    p_limit INT DEFAULT 10
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_detections JSONB;
BEGIN
    -- Gate 1: Get tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TENANT_NOT_FOUND',
            'message', 'Unable to determine tenant_id from request context'
        );
    END IF;

    -- Gate 2: Get user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Clamp limit
    p_limit := GREATEST(1, LEAST(50, p_limit));

    -- Get detections
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'overload_id', id,
        'dimension', dimension,
        'confidence', confidence,
        'time_window', time_window,
        'observed_patterns', observed_patterns,
        'potential_impact', potential_impact,
        'explainability_text', explainability_text,
        'dismissible', dismissible,
        'dismissed_at', dismissed_at,
        'dismissed_reason', dismissed_reason,
        'created_at', created_at,
        'updated_at', updated_at
    ) ORDER BY created_at DESC), '[]'::JSONB)
    INTO v_detections
    FROM public.overload_detections
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND deleted_at IS NULL
      AND (p_include_dismissed OR dismissed_at IS NULL)
    LIMIT p_limit;

    RETURN jsonb_build_object(
        'ok', true,
        'detections', v_detections,
        'count', jsonb_array_length(v_detections)
    );
END;
$$;

-- ===========================================================================
-- 9. RPC: overload_dismiss()
-- Dismiss a detection
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.overload_dismiss(
    p_overload_id UUID,
    p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_detection RECORD;
BEGIN
    -- Gate 1: Get tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TENANT_NOT_FOUND',
            'message', 'Unable to determine tenant_id from request context'
        );
    END IF;

    -- Gate 2: Get user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Find detection
    SELECT * INTO v_detection
    FROM public.overload_detections
    WHERE id = p_overload_id
      AND tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND deleted_at IS NULL;

    IF v_detection IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'NOT_FOUND',
            'message', 'Detection not found'
        );
    END IF;

    IF v_detection.dismissed_at IS NOT NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'ALREADY_DISMISSED',
            'message', 'Detection already dismissed'
        );
    END IF;

    -- Dismiss detection
    UPDATE public.overload_detections
    SET dismissed_at = NOW(),
        dismissed_reason = p_reason,
        updated_at = NOW()
    WHERE id = p_overload_id;

    RETURN jsonb_build_object(
        'ok', true,
        'message', 'Detection dismissed',
        'overload_id', p_overload_id,
        'dismissed_at', NOW()
    );
END;
$$;

-- ===========================================================================
-- 10. RPC: overload_record_pattern()
-- Record an observed pattern (used by detection engine)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.overload_record_pattern(
    p_pattern_type TEXT,
    p_dimension TEXT,
    p_signal_sources TEXT[],
    p_intensity INT DEFAULT 50,
    p_trend_direction TEXT DEFAULT 'stable',
    p_supporting_evidence TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_pattern_id UUID;
    v_existing RECORD;
BEGIN
    -- Gate 1: Get tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TENANT_NOT_FOUND',
            'message', 'Unable to determine tenant_id from request context'
        );
    END IF;

    -- Gate 2: Get user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Clamp intensity
    p_intensity := GREATEST(0, LEAST(100, p_intensity));

    -- Check for existing pattern of same type within last 7 days
    SELECT * INTO v_existing
    FROM public.overload_patterns
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND pattern_type = p_pattern_type
      AND dimension = p_dimension
      AND deleted_at IS NULL
      AND first_observed_at >= NOW() - INTERVAL '7 days';

    IF v_existing IS NOT NULL THEN
        -- Update existing pattern
        UPDATE public.overload_patterns
        SET observation_count = observation_count + 1,
            intensity = (intensity + p_intensity) / 2,  -- Average
            trend_direction = p_trend_direction,
            signal_sources = ARRAY(SELECT DISTINCT unnest(signal_sources || p_signal_sources)),
            supporting_evidence = COALESCE(p_supporting_evidence, supporting_evidence),
            updated_at = NOW()
        WHERE id = v_existing.id
        RETURNING id INTO v_pattern_id;
    ELSE
        -- Insert new pattern
        INSERT INTO public.overload_patterns (
            tenant_id, user_id, pattern_type, dimension,
            signal_sources, intensity, trend_direction, supporting_evidence
        ) VALUES (
            v_tenant_id, v_user_id, p_pattern_type, p_dimension,
            p_signal_sources, p_intensity, p_trend_direction, p_supporting_evidence
        )
        RETURNING id INTO v_pattern_id;
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'pattern_id', v_pattern_id,
        'pattern_type', p_pattern_type,
        'dimension', p_dimension
    );
END;
$$;

-- ===========================================================================
-- 11. RPC: overload_explain()
-- Get detailed explanation for a detection
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.overload_explain(
    p_overload_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_detection RECORD;
BEGIN
    -- Gate 1: Get tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TENANT_NOT_FOUND',
            'message', 'Unable to determine tenant_id from request context'
        );
    END IF;

    -- Gate 2: Get user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Find detection
    SELECT * INTO v_detection
    FROM public.overload_detections
    WHERE id = p_overload_id
      AND tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND deleted_at IS NULL;

    IF v_detection IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'NOT_FOUND',
            'message', 'Detection not found'
        );
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'detection', jsonb_build_object(
            'overload_id', v_detection.id,
            'dimension', v_detection.dimension,
            'confidence', v_detection.confidence,
            'time_window', v_detection.time_window,
            'observed_patterns', v_detection.observed_patterns,
            'potential_impact', v_detection.potential_impact,
            'explainability_text', v_detection.explainability_text,
            'dismissible', v_detection.dismissible,
            'created_at', v_detection.created_at
        ),
        'patterns', v_detection.pattern_details,
        'baseline_deviation', v_detection.baseline_deviation,
        'disclaimer', v_detection.disclaimer
    );
END;
$$;

-- ===========================================================================
-- 12. Permissions
-- ===========================================================================

-- Grant execute on RPCs to authenticated users
GRANT EXECUTE ON FUNCTION public.overload_compute_baselines(TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.overload_get_baselines(TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.overload_detect(INT, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.overload_get_detections(BOOLEAN, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.overload_dismiss(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.overload_record_pattern(TEXT, TEXT, TEXT[], INT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.overload_explain(UUID) TO authenticated;

-- Grant table access (RLS enforces row-level security)
GRANT SELECT ON public.overload_detections TO authenticated;
GRANT SELECT ON public.overload_baselines TO authenticated;
GRANT SELECT ON public.overload_patterns TO authenticated;

-- ===========================================================================
-- 13. Comments
-- ===========================================================================

COMMENT ON TABLE public.overload_detections IS 'VTID-01145: D51 Overload detection records. Pattern-based awareness signals, not diagnostic.';
COMMENT ON TABLE public.overload_baselines IS 'VTID-01145: User baseline snapshots for deviation comparison.';
COMMENT ON TABLE public.overload_patterns IS 'VTID-01145: Observed pattern history contributing to detections.';

COMMENT ON FUNCTION public.overload_detect IS 'VTID-01145: Main detection function. Analyzes patterns and creates detections meeting strict criteria.';
COMMENT ON FUNCTION public.overload_get_detections IS 'VTID-01145: Get current active detections for user.';
COMMENT ON FUNCTION public.overload_dismiss IS 'VTID-01145: Dismiss a detection. User can always dismiss.';
COMMENT ON FUNCTION public.overload_explain IS 'VTID-01145: Get detailed explanation for a detection.';
