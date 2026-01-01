-- Migration: 20251231000001_vtid_01085_memory_retrieve_router.sql
-- Purpose: VTID-01085 Memory Retrieve Router v1 - unified retrieval gateway for ORB/AI Assistant
-- Date: 2025-12-31
--
-- Creates:
--   1. memory_retrieve_audit - Audit trail for all memory retrieval operations
--   2. memory_access_grants - Role-based access control for memory (diary/garden)
--   3. memory_garden_nodes - Memory Garden summary (habits/values/goals/signals)
--   4. memory_retrieve RPC - Unified retrieval function with role-based access
--
-- Dependencies:
--   - VTID-01101 (Phase A-Fix) - tenant/user/role helpers
--   - VTID-01103 (Health Compute Engine) - vitana_index_scores, recommendations
--   - VTID-01104 (Memory Core v1) - memory_items, memory_categories

-- ===========================================================================
-- 1. MEMORY RETRIEVE AUDIT TABLE
-- ===========================================================================
-- Tracks all memory retrieval operations for compliance and debugging

CREATE TABLE IF NOT EXISTS public.memory_retrieve_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    target_user_id UUID NOT NULL,       -- User whose memory is being retrieved
    requester_user_id UUID NOT NULL,    -- User making the request
    active_role TEXT NOT NULL,          -- Role of the requester at time of request
    intent TEXT NOT NULL CHECK (intent IN ('health', 'longevity', 'community', 'lifestyle', 'planner', 'general')),
    mode TEXT NOT NULL CHECK (mode IN ('summary', 'detail')),
    time_range JSONB,                   -- { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }
    include_config JSONB NOT NULL,      -- { "diary": true, "garden": true, "longevity": true, "community": true }
    query_text TEXT,                    -- Optional keyword query
    decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
    redactions JSONB DEFAULT '[]'::JSONB,  -- Array of redacted fields/reasons
    sources_accessed JSONB DEFAULT '{}'::JSONB, -- { "diary_entries": N, "garden_nodes": N, ... }
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient audit queries
CREATE INDEX IF NOT EXISTS idx_memory_retrieve_audit_tenant
    ON public.memory_retrieve_audit (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_retrieve_audit_target_user
    ON public.memory_retrieve_audit (target_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_retrieve_audit_requester
    ON public.memory_retrieve_audit (requester_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_retrieve_audit_decision
    ON public.memory_retrieve_audit (decision, created_at DESC);

-- ===========================================================================
-- 2. MEMORY ACCESS GRANTS TABLE
-- ===========================================================================
-- Role-based access control for diary and garden data
-- Mirrors pattern of health_access_grants but for memory

CREATE TABLE IF NOT EXISTS public.memory_access_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    grantor_user_id UUID NOT NULL,      -- User granting access (patient)
    grantee_user_id UUID NOT NULL,      -- User receiving access (professional/staff)
    grantee_role TEXT NOT NULL CHECK (grantee_role IN ('professional', 'staff', 'admin')),
    access_type TEXT NOT NULL CHECK (access_type IN ('diary', 'garden', 'full')),
    scope TEXT NOT NULL DEFAULT 'read' CHECK (scope IN ('read', 'read_write')),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,             -- NULL means no expiration
    revoked_at TIMESTAMPTZ,             -- NULL means not revoked
    revoke_reason TEXT,
    metadata JSONB DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT memory_access_grants_unique UNIQUE (tenant_id, grantor_user_id, grantee_user_id, access_type)
);

-- Indexes for efficient grant lookups
CREATE INDEX IF NOT EXISTS idx_memory_access_grants_tenant
    ON public.memory_access_grants (tenant_id);
CREATE INDEX IF NOT EXISTS idx_memory_access_grants_grantor
    ON public.memory_access_grants (grantor_user_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_memory_access_grants_grantee
    ON public.memory_access_grants (grantee_user_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_memory_access_grants_active
    ON public.memory_access_grants (grantee_user_id, access_type)
    WHERE revoked_at IS NULL;

-- ===========================================================================
-- 3. MEMORY GARDEN NODES TABLE
-- ===========================================================================
-- Memory Garden summary: habits, values, goals, signals
-- These are distilled/aggregated insights from memory_items

CREATE TABLE IF NOT EXISTS public.memory_garden_nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    node_type TEXT NOT NULL CHECK (node_type IN ('habit', 'value', 'goal', 'signal', 'trait', 'preference')),
    node_key TEXT NOT NULL,             -- Unique key within type (e.g., "morning_routine", "family_first")
    title TEXT NOT NULL,
    description TEXT,
    confidence NUMERIC NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
    evidence_count INT NOT NULL DEFAULT 0,  -- Number of memory items supporting this
    source_memory_ids UUID[] DEFAULT '{}',  -- References to source memory_items
    tags TEXT[] DEFAULT '{}',
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- When this was last evidenced
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT memory_garden_nodes_unique UNIQUE (tenant_id, user_id, node_type, node_key)
);

-- Indexes for efficient garden queries
CREATE INDEX IF NOT EXISTS idx_memory_garden_nodes_tenant_user
    ON public.memory_garden_nodes (tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_memory_garden_nodes_type
    ON public.memory_garden_nodes (user_id, node_type, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_memory_garden_nodes_last_seen
    ON public.memory_garden_nodes (user_id, last_seen_at DESC);

-- ===========================================================================
-- 4. RLS POLICIES
-- ===========================================================================

-- Enable RLS on all tables
ALTER TABLE public.memory_retrieve_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_garden_nodes ENABLE ROW LEVEL SECURITY;

-- memory_retrieve_audit: Service role can insert/select, users can see their own
DROP POLICY IF EXISTS memory_retrieve_audit_insert ON public.memory_retrieve_audit;
CREATE POLICY memory_retrieve_audit_insert ON public.memory_retrieve_audit
    FOR INSERT
    TO authenticated
    WITH CHECK (
        requester_user_id = auth.uid()
        AND tenant_id = public.current_tenant_id()
    );

DROP POLICY IF EXISTS memory_retrieve_audit_select ON public.memory_retrieve_audit;
CREATE POLICY memory_retrieve_audit_select ON public.memory_retrieve_audit
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND (target_user_id = auth.uid() OR requester_user_id = auth.uid())
    );

-- memory_access_grants: Users can manage their own grants (as grantor)
DROP POLICY IF EXISTS memory_access_grants_grantor ON public.memory_access_grants;
CREATE POLICY memory_access_grants_grantor ON public.memory_access_grants
    FOR ALL
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND grantor_user_id = auth.uid()
    )
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND grantor_user_id = auth.uid()
    );

-- Grantees can see grants they have received
DROP POLICY IF EXISTS memory_access_grants_grantee_select ON public.memory_access_grants;
CREATE POLICY memory_access_grants_grantee_select ON public.memory_access_grants
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND grantee_user_id = auth.uid()
    );

-- memory_garden_nodes: Users can only access their own
DROP POLICY IF EXISTS memory_garden_nodes_select ON public.memory_garden_nodes;
CREATE POLICY memory_garden_nodes_select ON public.memory_garden_nodes
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS memory_garden_nodes_insert ON public.memory_garden_nodes;
CREATE POLICY memory_garden_nodes_insert ON public.memory_garden_nodes
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS memory_garden_nodes_update ON public.memory_garden_nodes;
CREATE POLICY memory_garden_nodes_update ON public.memory_garden_nodes
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
-- 5. HELPER FUNCTION: Check memory access grant
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.check_memory_access_grant(
    p_target_user_id UUID,
    p_requester_user_id UUID,
    p_access_type TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_has_grant BOOLEAN;
BEGIN
    v_tenant_id := public.current_tenant_id();

    -- Check if active grant exists
    SELECT EXISTS (
        SELECT 1 FROM public.memory_access_grants
        WHERE tenant_id = v_tenant_id
          AND grantor_user_id = p_target_user_id
          AND grantee_user_id = p_requester_user_id
          AND (access_type = p_access_type OR access_type = 'full')
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
    ) INTO v_has_grant;

    RETURN v_has_grant;
END;
$$;

-- ===========================================================================
-- 6. HELPER FUNCTION: Compute trend delta
-- ===========================================================================
-- Compares last 3 days vs previous 3 days for a score pillar
-- Returns: 'improving' | 'stable' | 'declining'

CREATE OR REPLACE FUNCTION public.compute_trend_delta(
    p_user_id UUID,
    p_pillar TEXT,
    p_reference_date DATE DEFAULT CURRENT_DATE
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_recent_avg NUMERIC;
    v_previous_avg NUMERIC;
    v_delta NUMERIC;
BEGIN
    v_tenant_id := public.current_tenant_id();

    -- Get average of last 3 days
    SELECT AVG(
        CASE p_pillar
            WHEN 'total' THEN score_total
            WHEN 'physical' THEN score_physical
            WHEN 'mental' THEN score_mental
            WHEN 'nutritional' THEN score_nutritional
            WHEN 'social' THEN score_social
            WHEN 'environmental' THEN score_environmental
            ELSE score_total
        END
    )
    INTO v_recent_avg
    FROM public.vitana_index_scores
    WHERE user_id = p_user_id
      AND tenant_id = v_tenant_id
      AND date BETWEEN (p_reference_date - INTERVAL '2 days')::DATE AND p_reference_date;

    -- Get average of previous 3 days
    SELECT AVG(
        CASE p_pillar
            WHEN 'total' THEN score_total
            WHEN 'physical' THEN score_physical
            WHEN 'mental' THEN score_mental
            WHEN 'nutritional' THEN score_nutritional
            WHEN 'social' THEN score_social
            WHEN 'environmental' THEN score_environmental
            ELSE score_total
        END
    )
    INTO v_previous_avg
    FROM public.vitana_index_scores
    WHERE user_id = p_user_id
      AND tenant_id = v_tenant_id
      AND date BETWEEN (p_reference_date - INTERVAL '5 days')::DATE
                   AND (p_reference_date - INTERVAL '3 days')::DATE;

    -- Handle null cases
    IF v_recent_avg IS NULL OR v_previous_avg IS NULL THEN
        RETURN 'stable';
    END IF;

    -- Compute delta percentage
    v_delta := ((v_recent_avg - v_previous_avg) / NULLIF(v_previous_avg, 0)) * 100;

    -- Deterministic thresholds: ±5% = stable
    IF v_delta > 5 THEN
        RETURN 'improving';
    ELSIF v_delta < -5 THEN
        RETURN 'declining';
    ELSE
        RETURN 'stable';
    END IF;
END;
$$;

-- ===========================================================================
-- 7. MAIN RPC: memory_retrieve
-- ===========================================================================
-- Unified retrieval gateway for the assistant (ORB / AI Assistant / Autopilot)

CREATE OR REPLACE FUNCTION public.memory_retrieve(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    -- Context
    v_tenant_id UUID;
    v_user_id UUID;
    v_active_role TEXT;
    v_audit_id UUID;

    -- Request params
    v_intent TEXT;
    v_mode TEXT;
    v_query TEXT;
    v_time_from DATE;
    v_time_to DATE;
    v_include_diary BOOLEAN;
    v_include_garden BOOLEAN;
    v_include_longevity BOOLEAN;
    v_include_community BOOLEAN;

    -- Access control
    v_decision TEXT := 'allow';
    v_redactions JSONB := '[]'::JSONB;

    -- Results
    v_diary_highlights JSONB := '[]'::JSONB;
    v_garden_summary JSONB := '{}'::JSONB;
    v_longevity_summary JSONB := '{}'::JSONB;
    v_community_recommendations JSONB := '[]'::JSONB;

    -- Counts
    v_diary_count INT := 0;
    v_garden_count INT := 0;
    v_longevity_count INT := 0;
    v_community_count INT := 0;
BEGIN
    -- =========================================================================
    -- GATE 1: Authentication & Context
    -- =========================================================================
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'NO_TENANT',
            'message', 'No tenant context'
        );
    END IF;

    v_active_role := public.current_active_role();

    -- =========================================================================
    -- GATE 2: Parse & Validate Request
    -- =========================================================================
    v_intent := COALESCE(p_payload->>'intent', 'general');
    v_mode := COALESCE(p_payload->>'mode', 'summary');
    v_query := p_payload->>'query';

    -- Validate intent
    IF v_intent NOT IN ('health', 'longevity', 'community', 'lifestyle', 'planner', 'general') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_INTENT',
            'message', 'intent must be one of: health, longevity, community, lifestyle, planner, general'
        );
    END IF;

    -- Validate mode
    IF v_mode NOT IN ('summary', 'detail') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_MODE',
            'message', 'mode must be one of: summary, detail'
        );
    END IF;

    -- Parse time range (default: last 7 days)
    v_time_from := COALESCE(
        (p_payload->'time_range'->>'from')::DATE,
        (CURRENT_DATE - INTERVAL '7 days')::DATE
    );
    v_time_to := COALESCE(
        (p_payload->'time_range'->>'to')::DATE,
        CURRENT_DATE
    );

    -- Parse include flags (default all true)
    v_include_diary := COALESCE((p_payload->'include'->>'diary')::BOOLEAN, true);
    v_include_garden := COALESCE((p_payload->'include'->>'garden')::BOOLEAN, true);
    v_include_longevity := COALESCE((p_payload->'include'->>'longevity')::BOOLEAN, true);
    v_include_community := COALESCE((p_payload->'include'->>'community')::BOOLEAN, true);

    -- =========================================================================
    -- GATE 3: Role-Based Access Control
    -- =========================================================================
    -- Patient can retrieve own full memory
    -- Professional/Staff/Admin: default deny for diary + garden unless grant exists

    IF v_active_role NOT IN ('patient', 'community', 'developer', 'infra') THEN
        -- Check for grants if not the data owner
        IF v_include_diary THEN
            IF NOT public.check_memory_access_grant(v_user_id, v_user_id, 'diary') THEN
                -- No grant for diary - deny access
                v_include_diary := false;
                v_redactions := v_redactions || jsonb_build_array(
                    jsonb_build_object('field', 'diary', 'reason', 'NO_GRANT')
                );
            END IF;
        END IF;

        IF v_include_garden THEN
            IF NOT public.check_memory_access_grant(v_user_id, v_user_id, 'garden') THEN
                -- No grant for garden - deny access
                v_include_garden := false;
                v_redactions := v_redactions || jsonb_build_array(
                    jsonb_build_object('field', 'garden', 'reason', 'NO_GRANT')
                );
            END IF;
        END IF;

        -- If all personal data is denied, mark decision as deny
        IF NOT v_include_diary AND NOT v_include_garden AND NOT v_include_longevity THEN
            v_decision := 'deny';
        END IF;
    END IF;

    -- =========================================================================
    -- FETCH 1: Diary Highlights (from memory_items with source='diary' or category='health')
    -- =========================================================================
    IF v_include_diary AND v_decision = 'allow' THEN
        IF v_mode = 'summary' THEN
            -- Summary mode: top 5 most important items
            SELECT COALESCE(
                jsonb_agg(item ORDER BY item->>'importance' DESC),
                '[]'::JSONB
            )
            INTO v_diary_highlights
            FROM (
                SELECT jsonb_build_object(
                    'id', id,
                    'category', category_key,
                    'content', LEFT(content, 200),  -- Truncate for summary
                    'importance', importance,
                    'occurred_at', occurred_at
                ) as item
                FROM public.memory_items
                WHERE tenant_id = v_tenant_id
                  AND user_id = v_user_id
                  AND occurred_at::DATE BETWEEN v_time_from AND v_time_to
                  AND (v_query IS NULL OR content ILIKE '%' || v_query || '%')
                ORDER BY importance DESC, occurred_at DESC
                LIMIT 5
            ) sub;
        ELSE
            -- Detail mode: full content, more items
            SELECT COALESCE(
                jsonb_agg(item ORDER BY item->>'occurred_at' DESC),
                '[]'::JSONB
            )
            INTO v_diary_highlights
            FROM (
                SELECT jsonb_build_object(
                    'id', id,
                    'category', category_key,
                    'source', source,
                    'content', content,
                    'content_json', content_json,
                    'importance', importance,
                    'occurred_at', occurred_at,
                    'created_at', created_at
                ) as item
                FROM public.memory_items
                WHERE tenant_id = v_tenant_id
                  AND user_id = v_user_id
                  AND occurred_at::DATE BETWEEN v_time_from AND v_time_to
                  AND (v_query IS NULL OR content ILIKE '%' || v_query || '%')
                ORDER BY occurred_at DESC
                LIMIT 20
            ) sub;
        END IF;

        v_diary_count := jsonb_array_length(v_diary_highlights);
    END IF;

    -- =========================================================================
    -- FETCH 2: Garden Summary (from memory_garden_nodes)
    -- =========================================================================
    IF v_include_garden AND v_decision = 'allow' THEN
        -- Get habits
        SELECT COALESCE(
            jsonb_agg(jsonb_build_object(
                'id', id,
                'key', node_key,
                'title', title,
                'confidence', confidence,
                'evidence_count', evidence_count,
                'last_seen_at', last_seen_at
            ) ORDER BY confidence DESC),
            '[]'::JSONB
        )
        INTO v_garden_summary
        FROM (
            SELECT * FROM public.memory_garden_nodes
            WHERE tenant_id = v_tenant_id
              AND user_id = v_user_id
              AND (v_query IS NULL OR title ILIKE '%' || v_query || '%' OR tags && ARRAY[v_query])
            ORDER BY confidence DESC, last_seen_at DESC
            LIMIT CASE WHEN v_mode = 'summary' THEN 10 ELSE 25 END
        ) nodes;

        -- Build structured garden summary
        SELECT jsonb_build_object(
            'habits', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'key', node_key,
                    'title', title,
                    'confidence', confidence
                ) ORDER BY confidence DESC)
                FROM public.memory_garden_nodes
                WHERE tenant_id = v_tenant_id AND user_id = v_user_id AND node_type = 'habit'
                LIMIT 5
            ), '[]'::JSONB),
            'values', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'key', node_key,
                    'title', title,
                    'confidence', confidence
                ) ORDER BY confidence DESC)
                FROM public.memory_garden_nodes
                WHERE tenant_id = v_tenant_id AND user_id = v_user_id AND node_type = 'value'
                LIMIT 5
            ), '[]'::JSONB),
            'goals', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'key', node_key,
                    'title', title,
                    'confidence', confidence
                ) ORDER BY confidence DESC)
                FROM public.memory_garden_nodes
                WHERE tenant_id = v_tenant_id AND user_id = v_user_id AND node_type = 'goal'
                LIMIT 5
            ), '[]'::JSONB),
            'signals', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'key', node_key,
                    'title', title,
                    'confidence', confidence
                ) ORDER BY last_seen_at DESC)
                FROM public.memory_garden_nodes
                WHERE tenant_id = v_tenant_id AND user_id = v_user_id AND node_type = 'signal'
                LIMIT 5
            ), '[]'::JSONB)
        ) INTO v_garden_summary;

        SELECT COUNT(*) INTO v_garden_count
        FROM public.memory_garden_nodes
        WHERE tenant_id = v_tenant_id AND user_id = v_user_id;
    END IF;

    -- =========================================================================
    -- FETCH 3: Longevity Summary (from vitana_index_scores)
    -- =========================================================================
    IF v_include_longevity AND v_decision = 'allow' THEN
        -- Get latest score and compute trend deltas
        SELECT jsonb_build_object(
            'latest_score', COALESCE((
                SELECT jsonb_build_object(
                    'date', date,
                    'total', score_total,
                    'physical', score_physical,
                    'mental', score_mental,
                    'nutritional', score_nutritional,
                    'social', score_social,
                    'environmental', score_environmental,
                    'confidence', confidence
                )
                FROM public.vitana_index_scores
                WHERE tenant_id = v_tenant_id AND user_id = v_user_id
                ORDER BY date DESC
                LIMIT 1
            ), '{}'::JSONB),
            'trends', jsonb_build_object(
                'total', public.compute_trend_delta(v_user_id, 'total'),
                'physical', public.compute_trend_delta(v_user_id, 'physical'),
                'mental', public.compute_trend_delta(v_user_id, 'mental'),
                'nutritional', public.compute_trend_delta(v_user_id, 'nutritional'),
                'social', public.compute_trend_delta(v_user_id, 'social'),
                'environmental', public.compute_trend_delta(v_user_id, 'environmental')
            ),
            'daily_signals', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'date', date,
                    'total', score_total,
                    'confidence', confidence
                ) ORDER BY date DESC)
                FROM public.vitana_index_scores
                WHERE tenant_id = v_tenant_id
                  AND user_id = v_user_id
                  AND date BETWEEN v_time_from AND v_time_to
                LIMIT 7
            ), '[]'::JSONB)
        ) INTO v_longevity_summary;

        SELECT COUNT(*) INTO v_longevity_count
        FROM public.vitana_index_scores
        WHERE tenant_id = v_tenant_id
          AND user_id = v_user_id
          AND date BETWEEN v_time_from AND v_time_to;
    END IF;

    -- =========================================================================
    -- FETCH 4: Community Recommendations
    -- =========================================================================
    IF v_include_community AND v_decision = 'allow' THEN
        SELECT COALESCE(
            jsonb_agg(jsonb_build_object(
                'id', id,
                'type', recommendation_type,
                'priority', priority,
                'title', title,
                'description', CASE WHEN v_mode = 'summary' THEN LEFT(description, 150) ELSE description END,
                'action_items', action_items,
                'related_pillar', related_score_pillar,
                'date', date
            ) ORDER BY priority DESC, date DESC),
            '[]'::JSONB
        )
        INTO v_community_recommendations
        FROM public.recommendations
        WHERE tenant_id = v_tenant_id
          AND user_id = v_user_id
          AND date BETWEEN v_time_from AND v_time_to
          AND safety_checked = true
          AND (expires_at IS NULL OR expires_at > NOW())
        LIMIT CASE WHEN v_mode = 'summary' THEN 6 ELSE 15 END;

        v_community_count := jsonb_array_length(v_community_recommendations);
    END IF;

    -- =========================================================================
    -- AUDIT: Write audit record
    -- =========================================================================
    INSERT INTO public.memory_retrieve_audit (
        tenant_id,
        target_user_id,
        requester_user_id,
        active_role,
        intent,
        mode,
        time_range,
        include_config,
        query_text,
        decision,
        redactions,
        sources_accessed
    ) VALUES (
        v_tenant_id,
        v_user_id,
        v_user_id,
        v_active_role,
        v_intent,
        v_mode,
        jsonb_build_object('from', v_time_from, 'to', v_time_to),
        jsonb_build_object(
            'diary', v_include_diary,
            'garden', v_include_garden,
            'longevity', v_include_longevity,
            'community', v_include_community
        ),
        v_query,
        v_decision,
        v_redactions,
        jsonb_build_object(
            'diary_entries', v_diary_count,
            'garden_nodes', v_garden_count,
            'longevity_days', v_longevity_count,
            'community_recs', v_community_count
        )
    )
    RETURNING id INTO v_audit_id;

    -- =========================================================================
    -- RETURN: Build response
    -- =========================================================================
    RETURN jsonb_build_object(
        'ok', true,
        'intent', v_intent,
        'mode', v_mode,
        'time_range', jsonb_build_object('from', v_time_from, 'to', v_time_to),
        'data', jsonb_build_object(
            'garden_summary', v_garden_summary,
            'longevity_summary', v_longevity_summary,
            'community_recommendations', v_community_recommendations,
            'diary_highlights', v_diary_highlights
        ),
        'meta', jsonb_build_object(
            'tenant_id', v_tenant_id,
            'user_id', v_user_id,
            'active_role', v_active_role,
            'redacted', jsonb_array_length(v_redactions) > 0,
            'redactions', v_redactions,
            'sources', jsonb_build_object(
                'diary_entries', v_diary_count,
                'garden_nodes', v_garden_count,
                'longevity_days', v_longevity_count,
                'community_recs', v_community_count
            ),
            'audit_id', v_audit_id
        )
    );
END;
$$;

-- ===========================================================================
-- 8. PERMISSIONS
-- ===========================================================================

-- Grant execute on functions to authenticated users
GRANT EXECUTE ON FUNCTION public.memory_retrieve(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_memory_access_grant(UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.compute_trend_delta(UUID, TEXT, DATE) TO authenticated;

-- Grant table access (RLS enforces row-level access)
GRANT SELECT, INSERT ON public.memory_retrieve_audit TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memory_access_grants TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.memory_garden_nodes TO authenticated;

-- ===========================================================================
-- 9. COMMENTS
-- ===========================================================================

COMMENT ON TABLE public.memory_retrieve_audit IS 'VTID-01085: Audit trail for all memory retrieval operations';
COMMENT ON TABLE public.memory_access_grants IS 'VTID-01085: Role-based access grants for diary and garden data';
COMMENT ON TABLE public.memory_garden_nodes IS 'VTID-01085: Memory Garden nodes (habits, values, goals, signals)';
COMMENT ON FUNCTION public.memory_retrieve IS 'VTID-01085: Unified memory retrieval gateway for ORB/AI Assistant';
COMMENT ON FUNCTION public.check_memory_access_grant IS 'VTID-01085: Check if user has active memory access grant';
COMMENT ON FUNCTION public.compute_trend_delta IS 'VTID-01085: Compute deterministic trend delta (improving/stable/declining)';
