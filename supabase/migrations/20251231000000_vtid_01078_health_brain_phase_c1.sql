-- Migration: 20251231000000_vtid_01078_health_brain_phase_c1.sql
-- Purpose: VTID-01078 Phase C1 Health Brain DB Schema (tables + indexes + RLS + minimal RPC)
-- Date: 2025-12-31
-- Dependencies: VTID-01101 (Phase A-Fix), VTID-01102 (Phase B-Fix)
--
-- Creates the canonical Health Brain schema:
-- - 7 tables: lab_reports, biomarker_results, wearable_samples, health_features_daily,
--             vitana_index_scores, recommendations, safety_constraints
-- - Indexes for common query patterns
-- - RLS policies for tenant + user isolation
-- - 3 minimal RPC functions for data ingestion and retrieval

-- ===========================================================================
-- 1. EXTENSIONS (if needed)
-- ===========================================================================

-- gen_random_uuid() is available by default in Supabase (pgcrypto extension)

-- ===========================================================================
-- 2. HELPER: current_user_id() - Get user_id from request context or auth.uid()
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.current_user_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_user_id UUID;
BEGIN
    -- Try request context first (set by service_role calls)
    BEGIN
        v_user_id := current_setting('request.user_id', true)::UUID;
        IF v_user_id IS NOT NULL THEN
            RETURN v_user_id;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        -- Ignore errors from invalid UUID or missing setting
        NULL;
    END;

    -- Fallback to auth.uid() for authenticated users
    v_user_id := auth.uid();
    RETURN v_user_id;
END;
$$;

COMMENT ON FUNCTION public.current_user_id IS 'VTID-01078: Helper to get user_id from request context or auth.uid()';

-- Grant to authenticated users
GRANT EXECUTE ON FUNCTION public.current_user_id() TO authenticated;

-- ===========================================================================
-- 3. TABLES
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 3.1 lab_reports - Stores uploaded lab reports and parsed content
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.lab_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    source TEXT,
    report_date DATE,
    raw_file_ref TEXT,
    raw_text TEXT,
    parsed_json JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.lab_reports IS 'VTID-01078: Stores uploaded lab reports with raw content and parsed biomarker data';

-- ---------------------------------------------------------------------------
-- 3.2 biomarker_results - Individual biomarker measurements from lab reports
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.biomarker_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    lab_report_id UUID REFERENCES public.lab_reports(id) ON DELETE SET NULL,
    biomarker_code TEXT,
    name TEXT,
    value NUMERIC,
    unit TEXT,
    ref_range_low NUMERIC,
    ref_range_high NUMERIC,
    status TEXT, -- low|normal|high|critical
    measured_at TIMESTAMPTZ NOT NULL
);

COMMENT ON TABLE public.biomarker_results IS 'VTID-01078: Individual biomarker measurements extracted from lab reports';

-- ---------------------------------------------------------------------------
-- 3.3 wearable_samples - Time-series data from wearable devices
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.wearable_samples (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    provider TEXT,
    metric TEXT,
    ts TIMESTAMPTZ NOT NULL,
    value NUMERIC NOT NULL,
    unit TEXT,
    raw_json JSONB
);

COMMENT ON TABLE public.wearable_samples IS 'VTID-01078: Time-series data from wearable devices (Apple Health, Fitbit, etc.)';

-- ---------------------------------------------------------------------------
-- 3.4 health_features_daily - Aggregated daily health features for scoring
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.health_features_daily (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    date DATE NOT NULL,
    feature_key TEXT NOT NULL,
    feature_value NUMERIC NOT NULL,
    provenance JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_health_features_daily_tenant_user_date_key
        UNIQUE (tenant_id, user_id, date, feature_key)
);

COMMENT ON TABLE public.health_features_daily IS 'VTID-01078: Aggregated daily health features used for Vitana Index scoring';

-- ---------------------------------------------------------------------------
-- 3.5 vitana_index_scores - Daily Vitana health scores
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.vitana_index_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    date DATE NOT NULL,
    score_total INT NOT NULL CHECK (score_total >= 0 AND score_total <= 999),
    score_sleep INT,
    score_nutrition INT,
    score_exercise INT,
    score_hydration INT,
    score_mental INT,
    model_version TEXT,
    provenance JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_vitana_index_scores_tenant_user_date
        UNIQUE (tenant_id, user_id, date)
);

COMMENT ON TABLE public.vitana_index_scores IS 'VTID-01078: Daily Vitana Index scores with category breakdowns (0-999 scale)';

-- ---------------------------------------------------------------------------
-- 3.6 recommendations - AI-generated health recommendations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.recommendations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    category TEXT,
    title TEXT,
    body TEXT,
    evidence_refs JSONB,
    based_on JSONB,
    status TEXT DEFAULT 'active',
    safety_checked BOOLEAN DEFAULT FALSE
);

COMMENT ON TABLE public.recommendations IS 'VTID-01078: AI-generated health recommendations with evidence and safety tracking';

-- ---------------------------------------------------------------------------
-- 3.7 safety_constraints - User health constraints and red flags
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.safety_constraints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    type TEXT, -- allergy|contraindication|red_flag|scope_limit
    constraint_key TEXT,
    constraint_value TEXT,
    severity TEXT,
    source TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE public.safety_constraints IS 'VTID-01078: User health constraints (allergies, contraindications, red flags, scope limits)';

-- ===========================================================================
-- 4. INDEXES
-- ===========================================================================

-- lab_reports indexes
CREATE INDEX IF NOT EXISTS idx_lab_reports_tenant_user_date
    ON public.lab_reports (tenant_id, user_id, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_lab_reports_tenant_created
    ON public.lab_reports (tenant_id, created_at DESC);

-- biomarker_results indexes
CREATE INDEX IF NOT EXISTS idx_biomarker_results_tenant_user_measured
    ON public.biomarker_results (tenant_id, user_id, measured_at DESC);
CREATE INDEX IF NOT EXISTS idx_biomarker_results_tenant_code
    ON public.biomarker_results (tenant_id, biomarker_code);

-- wearable_samples indexes
CREATE INDEX IF NOT EXISTS idx_wearable_samples_tenant_user_ts
    ON public.wearable_samples (tenant_id, user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_wearable_samples_tenant_metric_ts
    ON public.wearable_samples (tenant_id, metric, ts DESC);

-- health_features_daily indexes
CREATE INDEX IF NOT EXISTS idx_health_features_daily_tenant_user_date
    ON public.health_features_daily (tenant_id, user_id, date DESC);

-- vitana_index_scores indexes
CREATE INDEX IF NOT EXISTS idx_vitana_index_scores_tenant_user_date
    ON public.vitana_index_scores (tenant_id, user_id, date DESC);

-- recommendations indexes
CREATE INDEX IF NOT EXISTS idx_recommendations_tenant_user_created
    ON public.recommendations (tenant_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recommendations_tenant_status
    ON public.recommendations (tenant_id, status);

-- safety_constraints indexes
CREATE INDEX IF NOT EXISTS idx_safety_constraints_tenant_user_created
    ON public.safety_constraints (tenant_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_safety_constraints_tenant_type
    ON public.safety_constraints (tenant_id, type);

-- ===========================================================================
-- 5. ENABLE RLS
-- ===========================================================================

ALTER TABLE public.lab_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.biomarker_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wearable_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_features_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vitana_index_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.safety_constraints ENABLE ROW LEVEL SECURITY;

-- ===========================================================================
-- 6. RLS POLICIES (Baseline - Tenant + User Isolation)
-- ===========================================================================

-- Helper comment: All policies use current_tenant_id() and current_user_id()
-- which resolve from request context or JWT claims (VTID-01051/01078)

-- ---------------------------------------------------------------------------
-- 6.1 lab_reports policies
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS lab_reports_select ON public.lab_reports;
CREATE POLICY lab_reports_select ON public.lab_reports
    FOR SELECT USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS lab_reports_insert ON public.lab_reports;
CREATE POLICY lab_reports_insert ON public.lab_reports
    FOR INSERT WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS lab_reports_update ON public.lab_reports;
CREATE POLICY lab_reports_update ON public.lab_reports
    FOR UPDATE USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS lab_reports_delete ON public.lab_reports;
CREATE POLICY lab_reports_delete ON public.lab_reports
    FOR DELETE USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

-- ---------------------------------------------------------------------------
-- 6.2 biomarker_results policies
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS biomarker_results_select ON public.biomarker_results;
CREATE POLICY biomarker_results_select ON public.biomarker_results
    FOR SELECT USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS biomarker_results_insert ON public.biomarker_results;
CREATE POLICY biomarker_results_insert ON public.biomarker_results
    FOR INSERT WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS biomarker_results_update ON public.biomarker_results;
CREATE POLICY biomarker_results_update ON public.biomarker_results
    FOR UPDATE USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS biomarker_results_delete ON public.biomarker_results;
CREATE POLICY biomarker_results_delete ON public.biomarker_results
    FOR DELETE USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

-- ---------------------------------------------------------------------------
-- 6.3 wearable_samples policies
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS wearable_samples_select ON public.wearable_samples;
CREATE POLICY wearable_samples_select ON public.wearable_samples
    FOR SELECT USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS wearable_samples_insert ON public.wearable_samples;
CREATE POLICY wearable_samples_insert ON public.wearable_samples
    FOR INSERT WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS wearable_samples_update ON public.wearable_samples;
CREATE POLICY wearable_samples_update ON public.wearable_samples
    FOR UPDATE USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS wearable_samples_delete ON public.wearable_samples;
CREATE POLICY wearable_samples_delete ON public.wearable_samples
    FOR DELETE USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

-- ---------------------------------------------------------------------------
-- 6.4 health_features_daily policies
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS health_features_daily_select ON public.health_features_daily;
CREATE POLICY health_features_daily_select ON public.health_features_daily
    FOR SELECT USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS health_features_daily_insert ON public.health_features_daily;
CREATE POLICY health_features_daily_insert ON public.health_features_daily
    FOR INSERT WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS health_features_daily_update ON public.health_features_daily;
CREATE POLICY health_features_daily_update ON public.health_features_daily
    FOR UPDATE USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS health_features_daily_delete ON public.health_features_daily;
CREATE POLICY health_features_daily_delete ON public.health_features_daily
    FOR DELETE USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

-- ---------------------------------------------------------------------------
-- 6.5 vitana_index_scores policies
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS vitana_index_scores_select ON public.vitana_index_scores;
CREATE POLICY vitana_index_scores_select ON public.vitana_index_scores
    FOR SELECT USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS vitana_index_scores_insert ON public.vitana_index_scores;
CREATE POLICY vitana_index_scores_insert ON public.vitana_index_scores
    FOR INSERT WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS vitana_index_scores_update ON public.vitana_index_scores;
CREATE POLICY vitana_index_scores_update ON public.vitana_index_scores
    FOR UPDATE USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS vitana_index_scores_delete ON public.vitana_index_scores;
CREATE POLICY vitana_index_scores_delete ON public.vitana_index_scores
    FOR DELETE USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

-- ---------------------------------------------------------------------------
-- 6.6 recommendations policies
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS recommendations_select ON public.recommendations;
CREATE POLICY recommendations_select ON public.recommendations
    FOR SELECT USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS recommendations_insert ON public.recommendations;
CREATE POLICY recommendations_insert ON public.recommendations
    FOR INSERT WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS recommendations_update ON public.recommendations;
CREATE POLICY recommendations_update ON public.recommendations
    FOR UPDATE USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS recommendations_delete ON public.recommendations;
CREATE POLICY recommendations_delete ON public.recommendations
    FOR DELETE USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

-- ---------------------------------------------------------------------------
-- 6.7 safety_constraints policies
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS safety_constraints_select ON public.safety_constraints;
CREATE POLICY safety_constraints_select ON public.safety_constraints
    FOR SELECT USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS safety_constraints_insert ON public.safety_constraints;
CREATE POLICY safety_constraints_insert ON public.safety_constraints
    FOR INSERT WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS safety_constraints_update ON public.safety_constraints;
CREATE POLICY safety_constraints_update ON public.safety_constraints
    FOR UPDATE USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS safety_constraints_delete ON public.safety_constraints;
CREATE POLICY safety_constraints_delete ON public.safety_constraints
    FOR DELETE USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

-- ===========================================================================
-- 7. MINIMAL RPC FUNCTIONS
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 7.1 health_ingest_lab_report(p_payload jsonb) - Ingest lab report + biomarkers
-- ---------------------------------------------------------------------------
-- Payload schema:
-- {
--   "source": "manual|pdf|api",
--   "report_date": "2025-01-15",
--   "raw_file_ref": "gs://bucket/path.pdf",
--   "raw_text": "...",
--   "parsed_json": {...},
--   "biomarkers": [
--     {
--       "biomarker_code": "HBA1C",
--       "name": "Hemoglobin A1c",
--       "value": 5.7,
--       "unit": "%",
--       "ref_range_low": 4.0,
--       "ref_range_high": 5.6,
--       "status": "high",
--       "measured_at": "2025-01-15T10:00:00Z"
--     }
--   ]
-- }

CREATE OR REPLACE FUNCTION public.health_ingest_lab_report(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_lab_report_id UUID;
    v_biomarker JSONB;
    v_biomarker_count INT := 0;
    v_report_date DATE;
BEGIN
    -- Derive tenant/user from context (never trust payload)
    v_tenant_id := public.current_tenant_id();
    v_user_id := public.current_user_id();

    -- Validate tenant and user
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'MISSING_TENANT',
            'message', 'Unable to determine tenant_id from context'
        );
    END IF;

    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'MISSING_USER',
            'message', 'Unable to determine user_id from context'
        );
    END IF;

    -- Parse report_date if provided
    BEGIN
        v_report_date := (p_payload->>'report_date')::DATE;
    EXCEPTION WHEN OTHERS THEN
        v_report_date := NULL;
    END;

    -- Insert lab report
    INSERT INTO public.lab_reports (
        tenant_id,
        user_id,
        source,
        report_date,
        raw_file_ref,
        raw_text,
        parsed_json
    ) VALUES (
        v_tenant_id,
        v_user_id,
        p_payload->>'source',
        v_report_date,
        p_payload->>'raw_file_ref',
        p_payload->>'raw_text',
        p_payload->'parsed_json'
    )
    RETURNING id INTO v_lab_report_id;

    -- Insert biomarkers if present
    IF p_payload ? 'biomarkers' AND jsonb_typeof(p_payload->'biomarkers') = 'array' THEN
        FOR v_biomarker IN SELECT * FROM jsonb_array_elements(p_payload->'biomarkers')
        LOOP
            INSERT INTO public.biomarker_results (
                tenant_id,
                user_id,
                lab_report_id,
                biomarker_code,
                name,
                value,
                unit,
                ref_range_low,
                ref_range_high,
                status,
                measured_at
            ) VALUES (
                v_tenant_id,
                v_user_id,
                v_lab_report_id,
                v_biomarker->>'biomarker_code',
                v_biomarker->>'name',
                (v_biomarker->>'value')::NUMERIC,
                v_biomarker->>'unit',
                (v_biomarker->>'ref_range_low')::NUMERIC,
                (v_biomarker->>'ref_range_high')::NUMERIC,
                v_biomarker->>'status',
                COALESCE(
                    (v_biomarker->>'measured_at')::TIMESTAMPTZ,
                    COALESCE(v_report_date::TIMESTAMPTZ, NOW())
                )
            );
            v_biomarker_count := v_biomarker_count + 1;
        END LOOP;
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'lab_report_id', v_lab_report_id,
        'biomarker_count', v_biomarker_count
    );
END;
$$;

COMMENT ON FUNCTION public.health_ingest_lab_report IS 'VTID-01078: Ingest lab report with optional biomarkers. Derives tenant/user from context.';

-- Grant to authenticated users
GRANT EXECUTE ON FUNCTION public.health_ingest_lab_report(JSONB) TO authenticated;

-- ---------------------------------------------------------------------------
-- 7.2 health_ingest_wearable_samples(p_payload jsonb) - Batch ingest wearable data
-- ---------------------------------------------------------------------------
-- Payload schema:
-- {
--   "provider": "apple_health",
--   "samples": [
--     {
--       "metric": "heart_rate",
--       "ts": "2025-01-15T10:00:00Z",
--       "value": 72,
--       "unit": "bpm",
--       "raw_json": {...}
--     }
--   ]
-- }

CREATE OR REPLACE FUNCTION public.health_ingest_wearable_samples(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_provider TEXT;
    v_sample JSONB;
    v_inserted_count INT := 0;
BEGIN
    -- Derive tenant/user from context (never trust payload)
    v_tenant_id := public.current_tenant_id();
    v_user_id := public.current_user_id();

    -- Validate tenant and user
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'MISSING_TENANT',
            'message', 'Unable to determine tenant_id from context'
        );
    END IF;

    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'MISSING_USER',
            'message', 'Unable to determine user_id from context'
        );
    END IF;

    -- Get provider from payload
    v_provider := p_payload->>'provider';

    -- Validate samples array
    IF NOT (p_payload ? 'samples' AND jsonb_typeof(p_payload->'samples') = 'array') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_PAYLOAD',
            'message', 'samples array is required'
        );
    END IF;

    -- Insert samples
    FOR v_sample IN SELECT * FROM jsonb_array_elements(p_payload->'samples')
    LOOP
        -- Skip samples without required fields
        IF v_sample->>'ts' IS NULL OR v_sample->>'value' IS NULL THEN
            CONTINUE;
        END IF;

        INSERT INTO public.wearable_samples (
            tenant_id,
            user_id,
            provider,
            metric,
            ts,
            value,
            unit,
            raw_json
        ) VALUES (
            v_tenant_id,
            v_user_id,
            v_provider,
            v_sample->>'metric',
            (v_sample->>'ts')::TIMESTAMPTZ,
            (v_sample->>'value')::NUMERIC,
            v_sample->>'unit',
            v_sample->'raw_json'
        );
        v_inserted_count := v_inserted_count + 1;
    END LOOP;

    RETURN jsonb_build_object(
        'ok', true,
        'inserted_count', v_inserted_count
    );
END;
$$;

COMMENT ON FUNCTION public.health_ingest_wearable_samples IS 'VTID-01078: Batch ingest wearable samples. Derives tenant/user from context.';

-- Grant to authenticated users
GRANT EXECUTE ON FUNCTION public.health_ingest_wearable_samples(JSONB) TO authenticated;

-- ---------------------------------------------------------------------------
-- 7.3 health_get_summary(p_from date, p_to date) - Get health summary for date range
-- ---------------------------------------------------------------------------
-- Returns:
-- {
--   "ok": true,
--   "date_range": {"from": "2025-01-01", "to": "2025-01-15"},
--   "latest_score": {...} or null,
--   "counts": {
--     "lab_reports": 2,
--     "biomarker_results": 15,
--     "wearable_samples": 1500,
--     "daily_features": 10,
--     "active_recommendations": 3,
--     "safety_constraints": 2
--   },
--   "active_recommendations": [...]
-- }

CREATE OR REPLACE FUNCTION public.health_get_summary(p_from DATE, p_to DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_latest_score JSONB;
    v_counts JSONB;
    v_active_recs JSONB;
    v_lab_count INT;
    v_biomarker_count INT;
    v_wearable_count INT;
    v_feature_count INT;
    v_rec_count INT;
    v_constraint_count INT;
BEGIN
    -- Derive tenant/user from context
    v_tenant_id := public.current_tenant_id();
    v_user_id := public.current_user_id();

    -- Validate tenant and user
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'MISSING_TENANT',
            'message', 'Unable to determine tenant_id from context'
        );
    END IF;

    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'MISSING_USER',
            'message', 'Unable to determine user_id from context'
        );
    END IF;

    -- Default date range if not provided
    IF p_from IS NULL THEN
        p_from := CURRENT_DATE - INTERVAL '30 days';
    END IF;
    IF p_to IS NULL THEN
        p_to := CURRENT_DATE;
    END IF;

    -- Get latest Vitana Index score in range
    SELECT jsonb_build_object(
        'date', date,
        'score_total', score_total,
        'score_sleep', score_sleep,
        'score_nutrition', score_nutrition,
        'score_exercise', score_exercise,
        'score_hydration', score_hydration,
        'score_mental', score_mental,
        'model_version', model_version
    ) INTO v_latest_score
    FROM public.vitana_index_scores
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND date BETWEEN p_from AND p_to
    ORDER BY date DESC
    LIMIT 1;

    -- Count lab reports in range
    SELECT COUNT(*) INTO v_lab_count
    FROM public.lab_reports
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND (report_date IS NULL OR report_date BETWEEN p_from AND p_to);

    -- Count biomarker results in range
    SELECT COUNT(*) INTO v_biomarker_count
    FROM public.biomarker_results
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND measured_at::DATE BETWEEN p_from AND p_to;

    -- Count wearable samples in range
    SELECT COUNT(*) INTO v_wearable_count
    FROM public.wearable_samples
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND ts::DATE BETWEEN p_from AND p_to;

    -- Count daily features in range
    SELECT COUNT(*) INTO v_feature_count
    FROM public.health_features_daily
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND date BETWEEN p_from AND p_to;

    -- Count active recommendations
    SELECT COUNT(*) INTO v_rec_count
    FROM public.recommendations
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND status = 'active';

    -- Count safety constraints
    SELECT COUNT(*) INTO v_constraint_count
    FROM public.safety_constraints
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id;

    -- Build counts object
    v_counts := jsonb_build_object(
        'lab_reports', v_lab_count,
        'biomarker_results', v_biomarker_count,
        'wearable_samples', v_wearable_count,
        'daily_features', v_feature_count,
        'active_recommendations', v_rec_count,
        'safety_constraints', v_constraint_count
    );

    -- Get latest active recommendations (limit 10)
    SELECT COALESCE(jsonb_agg(rec_row), '[]'::JSONB)
    INTO v_active_recs
    FROM (
        SELECT jsonb_build_object(
            'id', id,
            'category', category,
            'title', title,
            'body', body,
            'created_at', created_at,
            'safety_checked', safety_checked
        ) AS rec_row
        FROM public.recommendations
        WHERE tenant_id = v_tenant_id
          AND user_id = v_user_id
          AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 10
    ) sub;

    RETURN jsonb_build_object(
        'ok', true,
        'date_range', jsonb_build_object('from', p_from, 'to', p_to),
        'latest_score', v_latest_score,
        'counts', v_counts,
        'active_recommendations', v_active_recs
    );
END;
$$;

COMMENT ON FUNCTION public.health_get_summary IS 'VTID-01078: Get health summary for date range including latest score, counts, and active recommendations.';

-- Grant to authenticated users
GRANT EXECUTE ON FUNCTION public.health_get_summary(DATE, DATE) TO authenticated;

-- ===========================================================================
-- 8. VERIFICATION QUERIES (run these to verify migration success)
-- ===========================================================================

/*
-- Verify tables exist:
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'lab_reports', 'biomarker_results', 'wearable_samples',
    'health_features_daily', 'vitana_index_scores',
    'recommendations', 'safety_constraints'
  );

-- Verify RLS is enabled:
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    'lab_reports', 'biomarker_results', 'wearable_samples',
    'health_features_daily', 'vitana_index_scores',
    'recommendations', 'safety_constraints'
  );

-- Verify policies exist:
SELECT tablename, policyname
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'lab_reports', 'biomarker_results', 'wearable_samples',
    'health_features_daily', 'vitana_index_scores',
    'recommendations', 'safety_constraints'
  )
ORDER BY tablename, policyname;

-- Verify functions exist:
SELECT routine_name
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN (
    'current_user_id',
    'health_ingest_lab_report',
    'health_ingest_wearable_samples',
    'health_get_summary'
  );

-- Verify indexes exist:
SELECT indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname LIKE 'idx_%'
  AND tablename IN (
    'lab_reports', 'biomarker_results', 'wearable_samples',
    'health_features_daily', 'vitana_index_scores',
    'recommendations', 'safety_constraints'
  );
*/

-- ===========================================================================
-- END OF MIGRATION: VTID-01078 Phase C1 Health Brain DB Schema
-- ===========================================================================
