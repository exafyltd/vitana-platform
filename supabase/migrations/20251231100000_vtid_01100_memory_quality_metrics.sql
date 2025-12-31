-- Migration: 20251231100000_vtid_01100_memory_quality_metrics.sql
-- Purpose: VTID-01100 Memory Quality Metrics & Confidence Scoring
-- Date: 2025-12-31
--
-- Provides deterministic quality measurement for memory system:
-- - memory_quality_metrics table (daily snapshots)
-- - memory_compute_quality() RPC function
-- - memory_get_quality() RPC function
--
-- Dependencies:
--   - VTID-01101 (tenant/user helpers)
--   - VTID-01104 (memory_items, memory_categories)

-- ===========================================================================
-- 4.1 memory_quality_metrics Table
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.memory_quality_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    snapshot_date DATE NOT NULL,

    -- Individual metrics (0-100 each)
    diary_coverage INT NOT NULL DEFAULT 0 CHECK (diary_coverage >= 0 AND diary_coverage <= 100),
    garden_density INT NOT NULL DEFAULT 0 CHECK (garden_density >= 0 AND garden_density <= 100),
    relationship_depth INT NOT NULL DEFAULT 0 CHECK (relationship_depth >= 0 AND relationship_depth <= 100),
    topic_stability INT NOT NULL DEFAULT 0 CHECK (topic_stability >= 0 AND topic_stability <= 100),
    longevity_signal_completeness INT NOT NULL DEFAULT 0 CHECK (longevity_signal_completeness >= 0 AND longevity_signal_completeness <= 100),

    -- Penalty metrics (percentages)
    lock_ratio INT NOT NULL DEFAULT 0 CHECK (lock_ratio >= 0 AND lock_ratio <= 100),
    delete_ratio INT NOT NULL DEFAULT 0 CHECK (delete_ratio >= 0 AND delete_ratio <= 100),

    -- Overall quality score (0-100)
    overall_quality_score INT NOT NULL DEFAULT 0 CHECK (overall_quality_score >= 0 AND overall_quality_score <= 100),

    -- Metadata
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Unique constraint: one snapshot per user per day
    CONSTRAINT memory_quality_metrics_unique_snapshot
        UNIQUE (tenant_id, user_id, snapshot_date)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_memory_quality_metrics_tenant_user_date
    ON public.memory_quality_metrics (tenant_id, user_id, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS idx_memory_quality_metrics_tenant_date
    ON public.memory_quality_metrics (tenant_id, snapshot_date DESC);

-- ===========================================================================
-- 4.2 RLS Policies
-- ===========================================================================

ALTER TABLE public.memory_quality_metrics ENABLE ROW LEVEL SECURITY;

-- Allow users to read their own quality metrics
DROP POLICY IF EXISTS memory_quality_metrics_select ON public.memory_quality_metrics;
CREATE POLICY memory_quality_metrics_select ON public.memory_quality_metrics
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- Allow insert via RPC (SECURITY DEFINER functions will bypass RLS)
DROP POLICY IF EXISTS memory_quality_metrics_insert ON public.memory_quality_metrics;
CREATE POLICY memory_quality_metrics_insert ON public.memory_quality_metrics
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- Allow update via RPC (for upsert operations)
DROP POLICY IF EXISTS memory_quality_metrics_update ON public.memory_quality_metrics;
CREATE POLICY memory_quality_metrics_update ON public.memory_quality_metrics
    FOR UPDATE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    )
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- ===========================================================================
-- 4.3 RPC: memory_compute_quality
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.memory_compute_quality(
    p_user_id UUID DEFAULT NULL,
    p_date DATE DEFAULT CURRENT_DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_snapshot_id UUID;

    -- Metric calculations
    v_diary_coverage INT := 0;
    v_garden_density INT := 0;
    v_relationship_depth INT := 0;
    v_topic_stability INT := 0;
    v_longevity_completeness INT := 0;
    v_lock_ratio INT := 0;
    v_delete_ratio INT := 0;
    v_overall_score INT := 0;
    v_penalty INT := 0;

    -- Helper variables
    v_total_categories INT := 0;
    v_covered_categories INT := 0;
    v_diary_days INT := 0;
    v_total_items INT := 0;
    v_locked_items INT := 0;
    v_deleted_items INT := 0;
    v_longevity_days INT := 0;

    -- Confidence band
    v_band TEXT := 'Low';
BEGIN
    -- Derive tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TENANT_NOT_FOUND',
            'message', 'Unable to determine tenant_id from request context'
        );
    END IF;

    -- Use provided user_id or current auth user
    v_user_id := COALESCE(p_user_id, auth.uid());
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user and no user_id provided'
        );
    END IF;

    -- =========================================================================
    -- Metric 1: Diary Coverage (0-100)
    -- % days with diary entries in last 30 days
    -- Uses memory_items with source='diary'
    -- =========================================================================
    SELECT COUNT(DISTINCT occurred_at::date)
    INTO v_diary_days
    FROM public.memory_items
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND source = 'diary'
      AND occurred_at >= (p_date - INTERVAL '30 days')
      AND occurred_at <= p_date;

    v_diary_coverage := LEAST(100, ROUND((v_diary_days::numeric / 30.0) * 100)::INT);

    -- =========================================================================
    -- Metric 2: Garden Density (0-100)
    -- Categories with >=1 node / total active categories * 100
    -- Uses memory_items across categories
    -- =========================================================================
    SELECT COUNT(*) INTO v_total_categories
    FROM public.memory_categories
    WHERE is_active = true;

    IF v_total_categories > 0 THEN
        SELECT COUNT(DISTINCT category_key)
        INTO v_covered_categories
        FROM public.memory_items
        WHERE tenant_id = v_tenant_id
          AND user_id = v_user_id;

        v_garden_density := LEAST(100, ROUND((v_covered_categories::numeric / v_total_categories::numeric) * 100)::INT);
    END IF;

    -- =========================================================================
    -- Metric 3: Relationship Depth (0-100)
    -- avg(edge.strength) weighted by diversity
    -- NOTE: Requires relationship_graph table (VTID-01088+)
    -- Returns 0 until relationship tables exist
    -- =========================================================================
    -- Check if relationship tables exist and compute if available
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'memory_relationship_edges'
    ) THEN
        BEGIN
            EXECUTE format($q$
                SELECT COALESCE(LEAST(100, ROUND(AVG(strength))::INT), 0)
                FROM public.memory_relationship_edges
                WHERE tenant_id = %L AND user_id = %L
            $q$, v_tenant_id, v_user_id)
            INTO v_relationship_depth;
        EXCEPTION WHEN OTHERS THEN
            v_relationship_depth := 0;
        END;
    END IF;

    -- =========================================================================
    -- Metric 4: Topic Stability (0-100)
    -- 100 - avg daily topic delta (7-day window)
    -- NOTE: Requires topic tracking (VTID-01085+)
    -- Returns 50 (neutral) until topic tables exist
    -- =========================================================================
    -- For v1 without topic tracking, use category consistency as proxy
    -- More consistent category usage = higher stability
    DECLARE
        v_category_variance NUMERIC := 0;
    BEGIN
        WITH daily_categories AS (
            SELECT
                occurred_at::date as day,
                COUNT(DISTINCT category_key) as cat_count
            FROM public.memory_items
            WHERE tenant_id = v_tenant_id
              AND user_id = v_user_id
              AND occurred_at >= (p_date - INTERVAL '7 days')
              AND occurred_at <= p_date
            GROUP BY occurred_at::date
        )
        SELECT COALESCE(STDDEV(cat_count), 0)
        INTO v_category_variance
        FROM daily_categories;

        -- Lower variance = higher stability
        -- Max variance ~10 categories, so scale accordingly
        v_topic_stability := GREATEST(0, LEAST(100, (100 - (v_category_variance * 10))::INT));

        -- If no data, return neutral 50
        IF v_topic_stability = 100 AND v_diary_days = 0 AND v_covered_categories = 0 THEN
            v_topic_stability := 50;
        END IF;
    END;

    -- =========================================================================
    -- Metric 5: Longevity Signal Completeness (0-100)
    -- days with longevity_signals_daily / 7 * 100
    -- NOTE: Requires longevity_signals_daily table (VTID-01092+)
    -- Returns 0 until longevity tables exist
    -- =========================================================================
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'longevity_signals_daily'
    ) THEN
        BEGIN
            EXECUTE format($q$
                SELECT COUNT(DISTINCT signal_date)
                FROM public.longevity_signals_daily
                WHERE tenant_id = %L
                  AND user_id = %L
                  AND signal_date >= %L
                  AND signal_date <= %L
            $q$, v_tenant_id, v_user_id, (p_date - INTERVAL '7 days')::date, p_date)
            INTO v_longevity_days;

            v_longevity_completeness := LEAST(100, ROUND((v_longevity_days::numeric / 7.0) * 100)::INT);
        EXCEPTION WHEN OTHERS THEN
            v_longevity_completeness := 0;
        END;
    END IF;

    -- =========================================================================
    -- Metric 6 & 7: Lock and Delete Ratios
    -- NOTE: Requires memory governance columns (VTID-01097+)
    -- Returns 0 until governance columns exist
    -- =========================================================================
    -- Check if is_locked/is_deleted columns exist on memory_items
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
        AND table_name = 'memory_items'
        AND column_name = 'is_locked'
    ) THEN
        BEGIN
            EXECUTE format($q$
                SELECT
                    COUNT(*),
                    COUNT(*) FILTER (WHERE is_locked = true),
                    COUNT(*) FILTER (WHERE is_deleted = true)
                FROM public.memory_items
                WHERE tenant_id = %L AND user_id = %L
            $q$, v_tenant_id, v_user_id)
            INTO v_total_items, v_locked_items, v_deleted_items;

            IF v_total_items > 0 THEN
                v_lock_ratio := ROUND((v_locked_items::numeric / v_total_items::numeric) * 100)::INT;
                v_delete_ratio := ROUND((v_deleted_items::numeric / v_total_items::numeric) * 100)::INT;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            v_lock_ratio := 0;
            v_delete_ratio := 0;
        END;
    ELSE
        -- Without governance columns, count total items for baseline
        SELECT COUNT(*) INTO v_total_items
        FROM public.memory_items
        WHERE tenant_id = v_tenant_id AND user_id = v_user_id;
    END IF;

    -- =========================================================================
    -- Calculate Penalties
    -- =========================================================================
    v_penalty := 0;
    IF v_lock_ratio > 30 THEN
        v_penalty := v_penalty + 10;
    END IF;
    IF v_delete_ratio > 20 THEN
        v_penalty := v_penalty + 10;
    END IF;

    -- =========================================================================
    -- Calculate Overall Quality Score
    -- Formula: 0.20*diary + 0.20*garden + 0.20*relationship + 0.15*stability + 0.15*longevity - penalties
    -- =========================================================================
    v_overall_score := GREATEST(0, LEAST(100,
        ROUND(
            0.20 * v_diary_coverage +
            0.20 * v_garden_density +
            0.20 * v_relationship_depth +
            0.15 * v_topic_stability +
            0.15 * v_longevity_completeness
        )::INT - v_penalty
    ));

    -- =========================================================================
    -- Determine Confidence Band
    -- =========================================================================
    v_band := CASE
        WHEN v_overall_score >= 86 THEN 'Very High'
        WHEN v_overall_score >= 70 THEN 'High'
        WHEN v_overall_score >= 40 THEN 'Medium'
        ELSE 'Low'
    END;

    -- =========================================================================
    -- Upsert Snapshot
    -- =========================================================================
    INSERT INTO public.memory_quality_metrics (
        tenant_id,
        user_id,
        snapshot_date,
        diary_coverage,
        garden_density,
        relationship_depth,
        topic_stability,
        longevity_signal_completeness,
        lock_ratio,
        delete_ratio,
        overall_quality_score
    ) VALUES (
        v_tenant_id,
        v_user_id,
        p_date,
        v_diary_coverage,
        v_garden_density,
        v_relationship_depth,
        v_topic_stability,
        v_longevity_completeness,
        v_lock_ratio,
        v_delete_ratio,
        v_overall_score
    )
    ON CONFLICT ON CONSTRAINT memory_quality_metrics_unique_snapshot
    DO UPDATE SET
        diary_coverage = EXCLUDED.diary_coverage,
        garden_density = EXCLUDED.garden_density,
        relationship_depth = EXCLUDED.relationship_depth,
        topic_stability = EXCLUDED.topic_stability,
        longevity_signal_completeness = EXCLUDED.longevity_signal_completeness,
        lock_ratio = EXCLUDED.lock_ratio,
        delete_ratio = EXCLUDED.delete_ratio,
        overall_quality_score = EXCLUDED.overall_quality_score,
        created_at = NOW()
    RETURNING id INTO v_snapshot_id;

    -- =========================================================================
    -- Return Result
    -- =========================================================================
    RETURN jsonb_build_object(
        'ok', true,
        'snapshot_id', v_snapshot_id,
        'snapshot_date', p_date,
        'metrics', jsonb_build_object(
            'diary_coverage', v_diary_coverage,
            'garden_density', v_garden_density,
            'relationship_depth', v_relationship_depth,
            'topic_stability', v_topic_stability,
            'longevity_signal_completeness', v_longevity_completeness,
            'lock_ratio', v_lock_ratio,
            'delete_ratio', v_delete_ratio
        ),
        'penalties', jsonb_build_object(
            'lock_penalty', CASE WHEN v_lock_ratio > 30 THEN 10 ELSE 0 END,
            'delete_penalty', CASE WHEN v_delete_ratio > 20 THEN 10 ELSE 0 END,
            'total_penalty', v_penalty
        ),
        'overall_quality_score', v_overall_score,
        'confidence_band', v_band,
        'explanations', jsonb_build_object(
            'diary_coverage', format('%s days with diary entries in last 30 days', v_diary_days),
            'garden_density', format('%s of %s categories covered', v_covered_categories, v_total_categories),
            'relationship_depth', CASE
                WHEN v_relationship_depth = 0 THEN 'Relationship tracking not yet available'
                ELSE format('Average relationship strength: %s', v_relationship_depth)
            END,
            'topic_stability', CASE
                WHEN v_diary_days = 0 AND v_covered_categories = 0 THEN 'Not enough data for stability analysis'
                ELSE format('Topic consistency score: %s/100', v_topic_stability)
            END,
            'longevity_signal_completeness', CASE
                WHEN v_longevity_completeness = 0 THEN 'Longevity tracking not yet available'
                ELSE format('%s of 7 days with longevity signals', v_longevity_days)
            END
        ),
        'improvements', CASE
            WHEN v_overall_score < 40 THEN jsonb_build_array(
                'Add diary entries regularly',
                'Use more memory categories',
                'Build relationships in the platform',
                'Enable longevity tracking'
            )
            WHEN v_overall_score < 70 THEN jsonb_build_array(
                'Increase diary consistency',
                'Explore more topic categories',
                'Strengthen relationship connections'
            )
            ELSE jsonb_build_array(
                'Maintain current engagement',
                'Continue building relationships'
            )
        END
    );
END;
$$;

-- ===========================================================================
-- 4.4 RPC: memory_get_quality
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.memory_get_quality(
    p_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_snapshot RECORD;
    v_band TEXT := 'Low';
BEGIN
    -- Derive tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TENANT_NOT_FOUND',
            'message', 'Unable to determine tenant_id from request context'
        );
    END IF;

    -- Use provided user_id or current auth user
    v_user_id := COALESCE(p_user_id, auth.uid());
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user and no user_id provided'
        );
    END IF;

    -- Get latest snapshot
    SELECT *
    INTO v_snapshot
    FROM public.memory_quality_metrics
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
    ORDER BY snapshot_date DESC
    LIMIT 1;

    -- If no snapshot exists, return empty result
    IF v_snapshot IS NULL THEN
        RETURN jsonb_build_object(
            'ok', true,
            'has_snapshot', false,
            'message', 'No quality snapshot available. Call memory_compute_quality to generate one.',
            'overall_quality_score', 0,
            'confidence_band', 'Low'
        );
    END IF;

    -- Determine confidence band
    v_band := CASE
        WHEN v_snapshot.overall_quality_score >= 86 THEN 'Very High'
        WHEN v_snapshot.overall_quality_score >= 70 THEN 'High'
        WHEN v_snapshot.overall_quality_score >= 40 THEN 'Medium'
        ELSE 'Low'
    END;

    -- Return snapshot data
    RETURN jsonb_build_object(
        'ok', true,
        'has_snapshot', true,
        'snapshot_id', v_snapshot.id,
        'snapshot_date', v_snapshot.snapshot_date,
        'metrics', jsonb_build_object(
            'diary_coverage', v_snapshot.diary_coverage,
            'garden_density', v_snapshot.garden_density,
            'relationship_depth', v_snapshot.relationship_depth,
            'topic_stability', v_snapshot.topic_stability,
            'longevity_signal_completeness', v_snapshot.longevity_signal_completeness,
            'lock_ratio', v_snapshot.lock_ratio,
            'delete_ratio', v_snapshot.delete_ratio
        ),
        'overall_quality_score', v_snapshot.overall_quality_score,
        'confidence_band', v_band,
        'created_at', v_snapshot.created_at
    );
END;
$$;

-- ===========================================================================
-- 4.5 Permissions
-- ===========================================================================

-- RPC functions: callable by authenticated users
GRANT EXECUTE ON FUNCTION public.memory_compute_quality(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.memory_get_quality(UUID) TO authenticated;

-- Table: allow authenticated users to interact (RLS will enforce row-level access)
GRANT SELECT, INSERT, UPDATE ON public.memory_quality_metrics TO authenticated;

-- ===========================================================================
-- 4.6 Comments
-- ===========================================================================

COMMENT ON TABLE public.memory_quality_metrics IS 'VTID-01100: Memory quality metrics snapshots for user memory confidence scoring';
COMMENT ON FUNCTION public.memory_compute_quality IS 'VTID-01100: Compute and store memory quality metrics for a user';
COMMENT ON FUNCTION public.memory_get_quality IS 'VTID-01100: Retrieve latest memory quality snapshot for a user';

-- ===========================================================================
-- End of VTID-01100 Migration
-- ===========================================================================
