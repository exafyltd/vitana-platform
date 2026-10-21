-- Migration: 20260102000000_vtid_01136_context_fusion_engine.sql
-- Purpose: VTID-01136 D42 Cross-Domain Context Fusion & Priority Resolution Engine
-- Date: 2026-01-02
--
-- Creates the deterministic Context Fusion Engine that resolves conflicts and
-- priorities across domains (health, social, learning, commerce, exploration)
-- so the system acts coherently as one intelligence.
--
-- D42 is the "context arbitrator" - answering:
-- "When multiple domains want to act, which one should lead — and which must wait?"
--
-- Dependencies:
--   - VTID-01101 (Phase A-Fix) - tenant/user/role helpers
--   - VTID-01102 (Phase B-Fix) - runtime context bridge
--   - VTID-01120 (D28) - emotional/cognitive signals (optional)
--
-- Non-Negotiable Priority Rules (from spec):
--   1. Health & safety override ALL other domains
--   2. Boundaries & consent override optimization
--   3. Monetization is ALWAYS lowest priority unless explicitly requested
--   4. Low availability suppresses multi-domain actions
--   5. Explicit user intent can override inferred priority

-- ===========================================================================
-- 1. d42_fusion_audit (Audit trail for fusion decisions)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.d42_fusion_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    session_id UUID NULL,
    turn_id UUID NULL,

    -- Input summary (privacy-conscious)
    input_summary JSONB NOT NULL DEFAULT '{}'::JSONB,
    -- Format: { "contexts_provided": [], "intent_type": string, "user_override": bool }

    -- Resolved action plan
    resolved_plan JSONB NOT NULL,
    -- Format: { "primary_domain": string, "secondary_domains": [], "deferred_domains": [],
    --           "suppressed_domains": [], "priority_tags": [], "constraints": {}, "rationale": string }

    -- Conflict resolution summary
    conflicts_count INT NOT NULL DEFAULT 0,
    conflicts_resolved JSONB DEFAULT '[]'::JSONB,
    -- Format: [{ "domains": [], "conflict_type": string, "strategy": string, "winner": string }]

    -- Rules applied
    rules_applied TEXT[] DEFAULT '{}',

    -- Performance metrics
    duration_ms INT NOT NULL DEFAULT 0,

    -- Input hash for determinism verification
    input_hash TEXT NOT NULL,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for efficient session/turn lookups
CREATE INDEX IF NOT EXISTS idx_d42_fusion_audit_session
    ON public.d42_fusion_audit (tenant_id, user_id, session_id, created_at DESC);

-- Index for primary domain analysis
CREATE INDEX IF NOT EXISTS idx_d42_fusion_audit_domain
    ON public.d42_fusion_audit (tenant_id, user_id, (resolved_plan->>'primary_domain'), created_at DESC);

-- ===========================================================================
-- 2. d42_priority_cache (Stability window cache to prevent oscillation)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.d42_priority_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    session_id UUID NULL,

    -- Cached priority state
    primary_domain TEXT NOT NULL,
    secondary_domains TEXT[] DEFAULT '{}',
    priority_tags TEXT[] DEFAULT '{}',

    -- Stability window
    stable_until TIMESTAMPTZ NOT NULL,

    -- Context hash for cache invalidation
    context_hash TEXT NOT NULL,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Unique constraint per session
    CONSTRAINT d42_priority_cache_unique
        UNIQUE NULLS NOT DISTINCT (tenant_id, user_id, session_id)
);

-- Index for cache lookups
CREATE INDEX IF NOT EXISTS idx_d42_priority_cache_lookup
    ON public.d42_priority_cache (tenant_id, user_id, session_id, stable_until DESC);

-- ===========================================================================
-- 3. d42_domain_weights (Configurable domain priority weights)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.d42_domain_weights (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    domain TEXT NOT NULL
        CHECK (domain IN (
            'health_wellbeing',
            'social_relationships',
            'learning_growth',
            'commerce_monetization',
            'exploration_discovery'
        )),

    -- Base weight (0-100)
    base_weight INT NOT NULL DEFAULT 50
        CHECK (base_weight >= 0 AND base_weight <= 100),

    -- Override reason
    override_reason TEXT NULL,

    -- Active flag
    active BOOLEAN NOT NULL DEFAULT true,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Unique per tenant/domain
    CONSTRAINT d42_domain_weights_unique
        UNIQUE (tenant_id, domain)
);

-- Seed default weights
INSERT INTO public.d42_domain_weights (tenant_id, domain, base_weight, override_reason)
SELECT
    '00000000-0000-0000-0000-000000000001'::UUID AS tenant_id,
    domain,
    CASE domain
        WHEN 'health_wellbeing' THEN 100
        WHEN 'social_relationships' THEN 70
        WHEN 'learning_growth' THEN 60
        WHEN 'exploration_discovery' THEN 50
        WHEN 'commerce_monetization' THEN 20
    END AS base_weight,
    'Default from spec' AS override_reason
FROM UNNEST(ARRAY[
    'health_wellbeing',
    'social_relationships',
    'learning_growth',
    'exploration_discovery',
    'commerce_monetization'
]) AS domain
ON CONFLICT (tenant_id, domain) DO NOTHING;

-- ===========================================================================
-- 4. Enable RLS on fusion tables
-- ===========================================================================

ALTER TABLE public.d42_fusion_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.d42_priority_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.d42_domain_weights ENABLE ROW LEVEL SECURITY;

-- d42_fusion_audit RLS
DROP POLICY IF EXISTS d42_fusion_audit_select ON public.d42_fusion_audit;
CREATE POLICY d42_fusion_audit_select ON public.d42_fusion_audit
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS d42_fusion_audit_insert ON public.d42_fusion_audit;
CREATE POLICY d42_fusion_audit_insert ON public.d42_fusion_audit
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

-- d42_priority_cache RLS
DROP POLICY IF EXISTS d42_priority_cache_select ON public.d42_priority_cache;
CREATE POLICY d42_priority_cache_select ON public.d42_priority_cache
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS d42_priority_cache_insert ON public.d42_priority_cache;
CREATE POLICY d42_priority_cache_insert ON public.d42_priority_cache
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS d42_priority_cache_update ON public.d42_priority_cache;
CREATE POLICY d42_priority_cache_update ON public.d42_priority_cache
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid())
    WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS d42_priority_cache_delete ON public.d42_priority_cache;
CREATE POLICY d42_priority_cache_delete ON public.d42_priority_cache
    FOR DELETE TO authenticated
    USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

-- d42_domain_weights RLS (read-only for authenticated, admin can modify)
DROP POLICY IF EXISTS d42_domain_weights_select ON public.d42_domain_weights;
CREATE POLICY d42_domain_weights_select ON public.d42_domain_weights
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id() OR tenant_id = '00000000-0000-0000-0000-000000000001'::UUID);

-- ===========================================================================
-- 5. RPC: d42_get_cached_priority(p_session_id uuid)
-- Returns cached priority if within stability window
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.d42_get_cached_priority(
    p_session_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_cache RECORD;
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

    -- Fetch cached priority if still valid
    SELECT * INTO v_cache
    FROM public.d42_priority_cache
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND (p_session_id IS NULL OR session_id = p_session_id)
      AND stable_until > NOW()
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_cache IS NULL THEN
        RETURN jsonb_build_object(
            'ok', true,
            'cached', false,
            'message', 'No valid cached priority'
        );
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'cached', true,
        'primary_domain', v_cache.primary_domain,
        'secondary_domains', to_jsonb(v_cache.secondary_domains),
        'priority_tags', to_jsonb(v_cache.priority_tags),
        'stable_until', v_cache.stable_until,
        'context_hash', v_cache.context_hash
    );
END;
$$;

-- ===========================================================================
-- 6. RPC: d42_set_cached_priority(...)
-- Stores priority in cache for stability window
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.d42_set_cached_priority(
    p_session_id UUID,
    p_primary_domain TEXT,
    p_secondary_domains TEXT[],
    p_priority_tags TEXT[],
    p_stability_seconds INT DEFAULT 60,
    p_context_hash TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_stable_until TIMESTAMPTZ;
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

    -- Calculate stable_until
    v_stable_until := NOW() + (p_stability_seconds || ' seconds')::INTERVAL;

    -- Upsert cache entry
    INSERT INTO public.d42_priority_cache (
        tenant_id,
        user_id,
        session_id,
        primary_domain,
        secondary_domains,
        priority_tags,
        stable_until,
        context_hash
    ) VALUES (
        v_tenant_id,
        v_user_id,
        p_session_id,
        p_primary_domain,
        COALESCE(p_secondary_domains, '{}'),
        COALESCE(p_priority_tags, '{}'),
        v_stable_until,
        COALESCE(p_context_hash, '')
    )
    ON CONFLICT (tenant_id, user_id, session_id)
    DO UPDATE SET
        primary_domain = EXCLUDED.primary_domain,
        secondary_domains = EXCLUDED.secondary_domains,
        priority_tags = EXCLUDED.priority_tags,
        stable_until = EXCLUDED.stable_until,
        context_hash = EXCLUDED.context_hash,
        updated_at = NOW();

    RETURN jsonb_build_object(
        'ok', true,
        'message', 'Priority cached',
        'stable_until', v_stable_until
    );
END;
$$;

-- ===========================================================================
-- 7. RPC: d42_invalidate_cache(p_session_id uuid)
-- Invalidates priority cache (forces recalculation)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.d42_invalidate_cache(
    p_session_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_deleted_count INT;
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

    -- Delete cache entries
    DELETE FROM public.d42_priority_cache
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND (p_session_id IS NULL OR session_id = p_session_id);

    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

    RETURN jsonb_build_object(
        'ok', true,
        'message', 'Cache invalidated',
        'deleted_count', v_deleted_count
    );
END;
$$;

-- ===========================================================================
-- 8. RPC: d42_store_audit(...)
-- Stores fusion decision audit entry
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.d42_store_audit(
    p_session_id UUID,
    p_turn_id UUID,
    p_input_summary JSONB,
    p_resolved_plan JSONB,
    p_conflicts_count INT,
    p_conflicts_resolved JSONB,
    p_rules_applied TEXT[],
    p_duration_ms INT,
    p_input_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_audit_id UUID;
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

    -- Insert audit entry
    INSERT INTO public.d42_fusion_audit (
        tenant_id,
        user_id,
        session_id,
        turn_id,
        input_summary,
        resolved_plan,
        conflicts_count,
        conflicts_resolved,
        rules_applied,
        duration_ms,
        input_hash
    ) VALUES (
        v_tenant_id,
        v_user_id,
        p_session_id,
        p_turn_id,
        COALESCE(p_input_summary, '{}'::JSONB),
        p_resolved_plan,
        COALESCE(p_conflicts_count, 0),
        COALESCE(p_conflicts_resolved, '[]'::JSONB),
        COALESCE(p_rules_applied, '{}'),
        COALESCE(p_duration_ms, 0),
        COALESCE(p_input_hash, '')
    )
    RETURNING id INTO v_audit_id;

    RETURN jsonb_build_object(
        'ok', true,
        'message', 'Audit stored',
        'audit_id', v_audit_id
    );
END;
$$;

-- ===========================================================================
-- 9. RPC: d42_get_domain_weights()
-- Returns domain weights for current tenant
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.d42_get_domain_weights()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_weights JSONB := '{}'::JSONB;
    v_weight RECORD;
BEGIN
    -- Get tenant_id from context
    v_tenant_id := public.current_tenant_id();

    -- Get weights, falling back to default tenant
    FOR v_weight IN
        SELECT domain, base_weight
        FROM public.d42_domain_weights
        WHERE (tenant_id = v_tenant_id OR tenant_id = '00000000-0000-0000-0000-000000000001'::UUID)
          AND active = true
        ORDER BY
            CASE WHEN tenant_id = v_tenant_id THEN 0 ELSE 1 END,
            domain
    LOOP
        -- Only set if not already set (tenant-specific takes precedence)
        IF NOT (v_weights ? v_weight.domain) THEN
            v_weights := jsonb_set(v_weights, ARRAY[v_weight.domain], to_jsonb(v_weight.base_weight));
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'ok', true,
        'weights', v_weights
    );
END;
$$;

-- ===========================================================================
-- 10. RPC: d42_get_fusion_history(p_limit int, p_offset int)
-- Returns recent fusion decisions for analysis
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.d42_get_fusion_history(
    p_limit INT DEFAULT 10,
    p_offset INT DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_history JSONB := '[]'::JSONB;
    v_entry RECORD;
    v_total_count INT;
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

    -- Get total count
    SELECT COUNT(*) INTO v_total_count
    FROM public.d42_fusion_audit
    WHERE tenant_id = v_tenant_id AND user_id = v_user_id;

    -- Get history
    FOR v_entry IN
        SELECT
            id,
            session_id,
            turn_id,
            resolved_plan->>'primary_domain' AS primary_domain,
            resolved_plan->'secondary_domains' AS secondary_domains,
            resolved_plan->'priority_tags' AS priority_tags,
            conflicts_count,
            duration_ms,
            created_at
        FROM public.d42_fusion_audit
        WHERE tenant_id = v_tenant_id AND user_id = v_user_id
        ORDER BY created_at DESC
        LIMIT p_limit
        OFFSET p_offset
    LOOP
        v_history := v_history || jsonb_build_object(
            'id', v_entry.id,
            'session_id', v_entry.session_id,
            'turn_id', v_entry.turn_id,
            'primary_domain', v_entry.primary_domain,
            'secondary_domains', v_entry.secondary_domains,
            'priority_tags', v_entry.priority_tags,
            'conflicts_count', v_entry.conflicts_count,
            'duration_ms', v_entry.duration_ms,
            'created_at', v_entry.created_at
        );
    END LOOP;

    RETURN jsonb_build_object(
        'ok', true,
        'history', v_history,
        'total_count', v_total_count,
        'limit', p_limit,
        'offset', p_offset
    );
END;
$$;

-- ===========================================================================
-- 11. Permissions
-- ===========================================================================

-- Grant execute on RPCs to authenticated users
GRANT EXECUTE ON FUNCTION public.d42_get_cached_priority(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.d42_set_cached_priority(UUID, TEXT, TEXT[], TEXT[], INT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.d42_invalidate_cache(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.d42_store_audit(UUID, UUID, JSONB, JSONB, INT, JSONB, TEXT[], INT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.d42_get_domain_weights() TO authenticated;
GRANT EXECUTE ON FUNCTION public.d42_get_fusion_history(INT, INT) TO authenticated;

-- Grant table access (RLS enforces row-level security)
GRANT SELECT, INSERT ON public.d42_fusion_audit TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.d42_priority_cache TO authenticated;
GRANT SELECT ON public.d42_domain_weights TO authenticated;

-- ===========================================================================
-- 12. Comments
-- ===========================================================================

COMMENT ON TABLE public.d42_fusion_audit IS 'VTID-01136: Audit trail for D42 cross-domain context fusion decisions. Supports D59 explainability.';
COMMENT ON TABLE public.d42_priority_cache IS 'VTID-01136: Stability window cache to prevent priority oscillation between turns.';
COMMENT ON TABLE public.d42_domain_weights IS 'VTID-01136: Configurable base priority weights per domain. Health=100, Commerce=20 by default.';

COMMENT ON FUNCTION public.d42_get_cached_priority IS 'VTID-01136: Returns cached priority if within stability window, prevents oscillation.';
COMMENT ON FUNCTION public.d42_set_cached_priority IS 'VTID-01136: Stores resolved priority in cache for stability window duration.';
COMMENT ON FUNCTION public.d42_invalidate_cache IS 'VTID-01136: Invalidates priority cache, forcing recalculation on next request.';
COMMENT ON FUNCTION public.d42_store_audit IS 'VTID-01136: Stores fusion decision audit entry for traceability (D59 support).';
COMMENT ON FUNCTION public.d42_get_domain_weights IS 'VTID-01136: Returns domain priority weights for current tenant.';
COMMENT ON FUNCTION public.d42_get_fusion_history IS 'VTID-01136: Returns recent fusion decisions for analysis and debugging.';
