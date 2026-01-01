-- Migration: 20251231100000_vtid_01092_services_products_memory.sql
-- Purpose: VTID-01092 Services + Products as Relationship Memory
-- Date: 2025-12-31
--
-- Models services and products as first-class relationship memory so the system can:
-- * recommend what's aligned with user's longevity goals
-- * track what they used, trusted, saved, or dismissed
-- * connect "usage → outcomes" deterministically (no medical claims)
-- * feed community lists + referrals later without spam
--
-- Dependencies:
--   - VTID-01101 (Phase A-Fix) - tenant/user/role helpers
--   - VTID-01104 (memory core) - memory categories and items

-- ===========================================================================
-- A. services_catalog - Catalog of available services
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.services_catalog (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    name TEXT NOT NULL CHECK (name != ''),
    service_type TEXT NOT NULL CHECK (service_type IN ('coach', 'doctor', 'lab', 'wellness', 'nutrition', 'fitness', 'therapy', 'other')),
    topic_keys TEXT[] NOT NULL DEFAULT '{}',
    provider_name TEXT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_services_catalog_tenant_type
    ON public.services_catalog (tenant_id, service_type);

CREATE INDEX IF NOT EXISTS idx_services_catalog_tenant_created
    ON public.services_catalog (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_services_catalog_topic_keys
    ON public.services_catalog USING GIN (topic_keys);

-- ===========================================================================
-- B. products_catalog - Catalog of available products
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.products_catalog (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    name TEXT NOT NULL CHECK (name != ''),
    product_type TEXT NOT NULL CHECK (product_type IN ('supplement', 'device', 'food', 'wearable', 'app', 'other')),
    topic_keys TEXT[] NOT NULL DEFAULT '{}',
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_products_catalog_tenant_type
    ON public.products_catalog (tenant_id, product_type);

CREATE INDEX IF NOT EXISTS idx_products_catalog_tenant_created
    ON public.products_catalog (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_products_catalog_topic_keys
    ON public.products_catalog USING GIN (topic_keys);

-- ===========================================================================
-- C. user_offers_memory - User relationship to services/products
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.user_offers_memory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    target_type TEXT NOT NULL CHECK (target_type IN ('service', 'product')),
    target_id UUID NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('viewed', 'saved', 'used', 'dismissed', 'rated')),
    trust_score INT NULL CHECK (trust_score IS NULL OR (trust_score >= 0 AND trust_score <= 100)),
    notes TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, user_id, target_type, target_id)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_user_offers_memory_tenant_user
    ON public.user_offers_memory (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_user_offers_memory_target
    ON public.user_offers_memory (target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_user_offers_memory_state
    ON public.user_offers_memory (tenant_id, user_id, state);

-- ===========================================================================
-- D. usage_outcomes - User-stated outcomes (safe, non-medical)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.usage_outcomes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    target_type TEXT NOT NULL CHECK (target_type IN ('service', 'product')),
    target_id UUID NOT NULL,
    outcome_date DATE NOT NULL,
    outcome_type TEXT NOT NULL CHECK (outcome_type IN ('sleep', 'stress', 'movement', 'nutrition', 'social', 'energy', 'other')),
    perceived_impact TEXT NOT NULL CHECK (perceived_impact IN ('better', 'same', 'worse')),
    evidence JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_usage_outcomes_tenant_user
    ON public.usage_outcomes (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_usage_outcomes_target
    ON public.usage_outcomes (target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_usage_outcomes_date
    ON public.usage_outcomes (tenant_id, user_id, outcome_date DESC);

-- ===========================================================================
-- E. relationship_edges - Graph edges between users and entities
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.relationship_edges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    target_type TEXT NOT NULL CHECK (target_type IN ('service', 'product', 'person', 'community')),
    target_id UUID NOT NULL,
    relationship_type TEXT NOT NULL CHECK (relationship_type IN ('using', 'trusted', 'saved', 'dismissed', 'connected', 'following')),
    strength INT NOT NULL DEFAULT 0 CHECK (strength >= -100 AND strength <= 100),
    context JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, user_id, target_type, target_id)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_relationship_edges_tenant_user
    ON public.relationship_edges (tenant_id, user_id, strength DESC);

CREATE INDEX IF NOT EXISTS idx_relationship_edges_target
    ON public.relationship_edges (target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_relationship_edges_type
    ON public.relationship_edges (tenant_id, user_id, relationship_type);

-- ===========================================================================
-- RLS Policies
-- ===========================================================================

-- Enable RLS on all tables
ALTER TABLE public.services_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_offers_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.relationship_edges ENABLE ROW LEVEL SECURITY;

-- services_catalog: tenant isolation for read, authenticated for insert
DROP POLICY IF EXISTS services_catalog_select ON public.services_catalog;
CREATE POLICY services_catalog_select ON public.services_catalog
    FOR SELECT
    TO authenticated
    USING (tenant_id = public.current_tenant_id());

DROP POLICY IF EXISTS services_catalog_insert ON public.services_catalog;
CREATE POLICY services_catalog_insert ON public.services_catalog
    FOR INSERT
    TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id());

-- products_catalog: tenant isolation for read, authenticated for insert
DROP POLICY IF EXISTS products_catalog_select ON public.products_catalog;
CREATE POLICY products_catalog_select ON public.products_catalog
    FOR SELECT
    TO authenticated
    USING (tenant_id = public.current_tenant_id());

DROP POLICY IF EXISTS products_catalog_insert ON public.products_catalog;
CREATE POLICY products_catalog_insert ON public.products_catalog
    FOR INSERT
    TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id());

-- user_offers_memory: user-tenant isolation
DROP POLICY IF EXISTS user_offers_memory_select ON public.user_offers_memory;
CREATE POLICY user_offers_memory_select ON public.user_offers_memory
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS user_offers_memory_insert ON public.user_offers_memory;
CREATE POLICY user_offers_memory_insert ON public.user_offers_memory
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS user_offers_memory_update ON public.user_offers_memory;
CREATE POLICY user_offers_memory_update ON public.user_offers_memory
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

-- usage_outcomes: user-tenant isolation
DROP POLICY IF EXISTS usage_outcomes_select ON public.usage_outcomes;
CREATE POLICY usage_outcomes_select ON public.usage_outcomes
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS usage_outcomes_insert ON public.usage_outcomes;
CREATE POLICY usage_outcomes_insert ON public.usage_outcomes
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- relationship_edges: user-tenant isolation
DROP POLICY IF EXISTS relationship_edges_select ON public.relationship_edges;
CREATE POLICY relationship_edges_select ON public.relationship_edges
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS relationship_edges_insert ON public.relationship_edges;
CREATE POLICY relationship_edges_insert ON public.relationship_edges
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS relationship_edges_update ON public.relationship_edges;
CREATE POLICY relationship_edges_update ON public.relationship_edges
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
-- RPC: catalog_add_service
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.catalog_add_service(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_name TEXT;
    v_service_type TEXT;
    v_topic_keys TEXT[];
    v_provider_name TEXT;
    v_metadata JSONB;
    v_new_id UUID;
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

    -- Extract payload fields
    v_name := p_payload->>'name';
    v_service_type := p_payload->>'service_type';
    v_provider_name := p_payload->>'provider_name';
    v_metadata := COALESCE(p_payload->'metadata', '{}'::JSONB);

    -- Parse topic_keys array
    IF p_payload->'topic_keys' IS NOT NULL THEN
        SELECT ARRAY_AGG(elem::TEXT)
        INTO v_topic_keys
        FROM jsonb_array_elements_text(p_payload->'topic_keys') AS elem;
    ELSE
        v_topic_keys := '{}';
    END IF;

    -- Validate required fields
    IF v_name IS NULL OR v_name = '' THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_NAME',
            'message', 'name is required'
        );
    END IF;

    IF v_service_type IS NULL OR v_service_type NOT IN ('coach', 'doctor', 'lab', 'wellness', 'nutrition', 'fitness', 'therapy', 'other') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_SERVICE_TYPE',
            'message', 'service_type must be one of: coach, doctor, lab, wellness, nutrition, fitness, therapy, other'
        );
    END IF;

    -- Insert the service
    INSERT INTO public.services_catalog (
        tenant_id,
        name,
        service_type,
        topic_keys,
        provider_name,
        metadata
    ) VALUES (
        v_tenant_id,
        v_name,
        v_service_type,
        v_topic_keys,
        v_provider_name,
        v_metadata
    )
    RETURNING id INTO v_new_id;

    -- Return success
    RETURN jsonb_build_object(
        'ok', true,
        'id', v_new_id,
        'name', v_name,
        'service_type', v_service_type
    );
END;
$$;

-- ===========================================================================
-- RPC: catalog_add_product
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.catalog_add_product(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_name TEXT;
    v_product_type TEXT;
    v_topic_keys TEXT[];
    v_metadata JSONB;
    v_new_id UUID;
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

    -- Extract payload fields
    v_name := p_payload->>'name';
    v_product_type := p_payload->>'product_type';
    v_metadata := COALESCE(p_payload->'metadata', '{}'::JSONB);

    -- Parse topic_keys array
    IF p_payload->'topic_keys' IS NOT NULL THEN
        SELECT ARRAY_AGG(elem::TEXT)
        INTO v_topic_keys
        FROM jsonb_array_elements_text(p_payload->'topic_keys') AS elem;
    ELSE
        v_topic_keys := '{}';
    END IF;

    -- Validate required fields
    IF v_name IS NULL OR v_name = '' THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_NAME',
            'message', 'name is required'
        );
    END IF;

    IF v_product_type IS NULL OR v_product_type NOT IN ('supplement', 'device', 'food', 'wearable', 'app', 'other') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_PRODUCT_TYPE',
            'message', 'product_type must be one of: supplement, device, food, wearable, app, other'
        );
    END IF;

    -- Insert the product
    INSERT INTO public.products_catalog (
        tenant_id,
        name,
        product_type,
        topic_keys,
        metadata
    ) VALUES (
        v_tenant_id,
        v_name,
        v_product_type,
        v_topic_keys,
        v_metadata
    )
    RETURNING id INTO v_new_id;

    -- Return success
    RETURN jsonb_build_object(
        'ok', true,
        'id', v_new_id,
        'name', v_name,
        'product_type', v_product_type
    );
END;
$$;

-- ===========================================================================
-- RPC: offers_set_state
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.offers_set_state(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_target_type TEXT;
    v_target_id UUID;
    v_state TEXT;
    v_trust_score INT;
    v_notes TEXT;
    v_existing_id UUID;
    v_new_id UUID;
    v_result_id UUID;
    v_strength_delta INT;
    v_relationship_type TEXT;
    v_edge_context JSONB;
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

    -- Derive user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Extract payload fields
    v_target_type := p_payload->>'target_type';
    v_target_id := (p_payload->>'target_id')::UUID;
    v_state := p_payload->>'state';
    v_trust_score := (p_payload->>'trust_score')::INT;
    v_notes := p_payload->>'notes';

    -- Validate required fields
    IF v_target_type IS NULL OR v_target_type NOT IN ('service', 'product') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_TARGET_TYPE',
            'message', 'target_type must be service or product'
        );
    END IF;

    IF v_target_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_TARGET_ID',
            'message', 'target_id is required'
        );
    END IF;

    IF v_state IS NULL OR v_state NOT IN ('viewed', 'saved', 'used', 'dismissed', 'rated') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_STATE',
            'message', 'state must be one of: viewed, saved, used, dismissed, rated'
        );
    END IF;

    -- Validate trust_score range if provided
    IF v_trust_score IS NOT NULL AND (v_trust_score < 0 OR v_trust_score > 100) THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_TRUST_SCORE',
            'message', 'trust_score must be between 0 and 100'
        );
    END IF;

    -- Check if record exists
    SELECT id INTO v_existing_id
    FROM public.user_offers_memory
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND target_type = v_target_type
      AND target_id = v_target_id;

    IF v_existing_id IS NOT NULL THEN
        -- Update existing record
        UPDATE public.user_offers_memory
        SET state = v_state,
            trust_score = COALESCE(v_trust_score, trust_score),
            notes = COALESCE(v_notes, notes),
            updated_at = NOW()
        WHERE id = v_existing_id;
        v_result_id := v_existing_id;
    ELSE
        -- Insert new record
        INSERT INTO public.user_offers_memory (
            tenant_id,
            user_id,
            target_type,
            target_id,
            state,
            trust_score,
            notes
        ) VALUES (
            v_tenant_id,
            v_user_id,
            v_target_type,
            v_target_id,
            v_state,
            v_trust_score,
            v_notes
        )
        RETURNING id INTO v_result_id;
    END IF;

    -- Calculate strength delta based on state (deterministic v1)
    -- viewed: +2, saved: +6, used: +12, rated trust_score>70: +10, dismissed: -20
    CASE v_state
        WHEN 'viewed' THEN
            v_strength_delta := 2;
            v_relationship_type := 'using';
        WHEN 'saved' THEN
            v_strength_delta := 6;
            v_relationship_type := 'saved';
        WHEN 'used' THEN
            v_strength_delta := 12;
            v_relationship_type := 'using';
        WHEN 'rated' THEN
            IF v_trust_score IS NOT NULL AND v_trust_score > 70 THEN
                v_strength_delta := 10;
                v_relationship_type := 'trusted';
            ELSE
                v_strength_delta := 2;
                v_relationship_type := 'using';
            END IF;
        WHEN 'dismissed' THEN
            v_strength_delta := -20;
            v_relationship_type := 'dismissed';
    END CASE;

    -- Build edge context
    v_edge_context := jsonb_build_object(
        'last_state', v_state,
        'last_updated', NOW()::TEXT
    );

    -- Add cooldown for dismissed items (14 days)
    IF v_state = 'dismissed' THEN
        v_edge_context := v_edge_context || jsonb_build_object(
            'cooldown_until', (NOW() + INTERVAL '14 days')::TEXT
        );
    END IF;

    -- Upsert relationship edge
    INSERT INTO public.relationship_edges (
        tenant_id,
        user_id,
        target_type,
        target_id,
        relationship_type,
        strength,
        context
    ) VALUES (
        v_tenant_id,
        v_user_id,
        v_target_type,
        v_target_id,
        v_relationship_type,
        v_strength_delta,
        v_edge_context
    )
    ON CONFLICT (tenant_id, user_id, target_type, target_id)
    DO UPDATE SET
        relationship_type = EXCLUDED.relationship_type,
        strength = LEAST(100, GREATEST(-100, relationship_edges.strength + v_strength_delta)),
        context = relationship_edges.context || v_edge_context,
        updated_at = NOW();

    -- Return success
    RETURN jsonb_build_object(
        'ok', true,
        'id', v_result_id,
        'target_type', v_target_type,
        'target_id', v_target_id,
        'state', v_state,
        'strength_delta', v_strength_delta
    );
END;
$$;

-- ===========================================================================
-- RPC: offers_record_outcome
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.offers_record_outcome(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_target_type TEXT;
    v_target_id UUID;
    v_outcome_date DATE;
    v_outcome_type TEXT;
    v_perceived_impact TEXT;
    v_evidence JSONB;
    v_new_id UUID;
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

    -- Derive user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Extract payload fields
    v_target_type := p_payload->>'target_type';
    v_target_id := (p_payload->>'target_id')::UUID;
    v_outcome_date := (p_payload->>'outcome_date')::DATE;
    v_outcome_type := p_payload->>'outcome_type';
    v_perceived_impact := p_payload->>'perceived_impact';
    v_evidence := COALESCE(p_payload->'evidence', '{}'::JSONB);

    -- Validate required fields
    IF v_target_type IS NULL OR v_target_type NOT IN ('service', 'product') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_TARGET_TYPE',
            'message', 'target_type must be service or product'
        );
    END IF;

    IF v_target_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_TARGET_ID',
            'message', 'target_id is required'
        );
    END IF;

    IF v_outcome_date IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_OUTCOME_DATE',
            'message', 'outcome_date is required'
        );
    END IF;

    IF v_outcome_type IS NULL OR v_outcome_type NOT IN ('sleep', 'stress', 'movement', 'nutrition', 'social', 'energy', 'other') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_OUTCOME_TYPE',
            'message', 'outcome_type must be one of: sleep, stress, movement, nutrition, social, energy, other'
        );
    END IF;

    IF v_perceived_impact IS NULL OR v_perceived_impact NOT IN ('better', 'same', 'worse') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_PERCEIVED_IMPACT',
            'message', 'perceived_impact must be one of: better, same, worse'
        );
    END IF;

    -- Insert the outcome
    INSERT INTO public.usage_outcomes (
        tenant_id,
        user_id,
        target_type,
        target_id,
        outcome_date,
        outcome_type,
        perceived_impact,
        evidence
    ) VALUES (
        v_tenant_id,
        v_user_id,
        v_target_type,
        v_target_id,
        v_outcome_date,
        v_outcome_type,
        v_perceived_impact,
        v_evidence
    )
    RETURNING id INTO v_new_id;

    -- Return success
    RETURN jsonb_build_object(
        'ok', true,
        'id', v_new_id,
        'target_type', v_target_type,
        'target_id', v_target_id,
        'outcome_type', v_outcome_type,
        'perceived_impact', v_perceived_impact
    );
END;
$$;

-- ===========================================================================
-- RPC: offers_get_recommendations
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.offers_get_recommendations(
    p_limit INT DEFAULT 10,
    p_target_type TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_services JSONB;
    v_products JSONB;
    v_cooldown_threshold TIMESTAMPTZ;
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

    -- Derive user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Cap limit
    IF p_limit IS NULL OR p_limit < 1 THEN
        p_limit := 10;
    ELSIF p_limit > 50 THEN
        p_limit := 50;
    END IF;

    -- Cooldown threshold (exclude dismissed items within 14 days)
    v_cooldown_threshold := NOW();

    -- Fetch services (if not filtered to products only)
    IF p_target_type IS NULL OR p_target_type = 'service' THEN
        SELECT COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'id', sc.id,
                    'name', sc.name,
                    'service_type', sc.service_type,
                    'topic_keys', sc.topic_keys,
                    'provider_name', sc.provider_name,
                    'metadata', sc.metadata,
                    'relationship_strength', COALESCE(re.strength, 0),
                    'user_state', uom.state,
                    'trust_score', uom.trust_score
                )
                ORDER BY COALESCE(re.strength, 0) DESC, sc.created_at DESC
            ),
            '[]'::JSONB
        )
        INTO v_services
        FROM public.services_catalog sc
        LEFT JOIN public.relationship_edges re
            ON re.tenant_id = v_tenant_id
            AND re.user_id = v_user_id
            AND re.target_type = 'service'
            AND re.target_id = sc.id
        LEFT JOIN public.user_offers_memory uom
            ON uom.tenant_id = v_tenant_id
            AND uom.user_id = v_user_id
            AND uom.target_type = 'service'
            AND uom.target_id = sc.id
        WHERE sc.tenant_id = v_tenant_id
          -- Exclude dismissed items in cooldown
          AND NOT EXISTS (
              SELECT 1 FROM public.relationship_edges re2
              WHERE re2.tenant_id = v_tenant_id
                AND re2.user_id = v_user_id
                AND re2.target_type = 'service'
                AND re2.target_id = sc.id
                AND re2.relationship_type = 'dismissed'
                AND (re2.context->>'cooldown_until')::TIMESTAMPTZ > v_cooldown_threshold
          )
        LIMIT p_limit;
    ELSE
        v_services := '[]'::JSONB;
    END IF;

    -- Fetch products (if not filtered to services only)
    IF p_target_type IS NULL OR p_target_type = 'product' THEN
        SELECT COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'id', pc.id,
                    'name', pc.name,
                    'product_type', pc.product_type,
                    'topic_keys', pc.topic_keys,
                    'metadata', pc.metadata,
                    'relationship_strength', COALESCE(re.strength, 0),
                    'user_state', uom.state,
                    'trust_score', uom.trust_score
                )
                ORDER BY COALESCE(re.strength, 0) DESC, pc.created_at DESC
            ),
            '[]'::JSONB
        )
        INTO v_products
        FROM public.products_catalog pc
        LEFT JOIN public.relationship_edges re
            ON re.tenant_id = v_tenant_id
            AND re.user_id = v_user_id
            AND re.target_type = 'product'
            AND re.target_id = pc.id
        LEFT JOIN public.user_offers_memory uom
            ON uom.tenant_id = v_tenant_id
            AND uom.user_id = v_user_id
            AND uom.target_type = 'product'
            AND uom.target_id = pc.id
        WHERE pc.tenant_id = v_tenant_id
          -- Exclude dismissed items in cooldown
          AND NOT EXISTS (
              SELECT 1 FROM public.relationship_edges re2
              WHERE re2.tenant_id = v_tenant_id
                AND re2.user_id = v_user_id
                AND re2.target_type = 'product'
                AND re2.target_id = pc.id
                AND re2.relationship_type = 'dismissed'
                AND (re2.context->>'cooldown_until')::TIMESTAMPTZ > v_cooldown_threshold
          )
        LIMIT p_limit;
    ELSE
        v_products := '[]'::JSONB;
    END IF;

    -- Return success with recommendations
    RETURN jsonb_build_object(
        'ok', true,
        'services', v_services,
        'products', v_products,
        'query', jsonb_build_object(
            'limit', p_limit,
            'target_type', p_target_type
        )
    );
END;
$$;

-- ===========================================================================
-- RPC: offers_get_memory
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.offers_get_memory(
    p_limit INT DEFAULT 20,
    p_target_type TEXT DEFAULT NULL,
    p_state TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_items JSONB;
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

    -- Derive user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Cap limit
    IF p_limit IS NULL OR p_limit < 1 THEN
        p_limit := 20;
    ELSIF p_limit > 100 THEN
        p_limit := 100;
    END IF;

    -- Fetch user's offers memory with catalog details
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', uom.id,
                'target_type', uom.target_type,
                'target_id', uom.target_id,
                'state', uom.state,
                'trust_score', uom.trust_score,
                'notes', uom.notes,
                'created_at', uom.created_at,
                'updated_at', uom.updated_at,
                'target_name', CASE
                    WHEN uom.target_type = 'service' THEN sc.name
                    WHEN uom.target_type = 'product' THEN pc.name
                    ELSE NULL
                END,
                'relationship_strength', re.strength
            )
            ORDER BY uom.updated_at DESC
        ),
        '[]'::JSONB
    )
    INTO v_items
    FROM public.user_offers_memory uom
    LEFT JOIN public.services_catalog sc
        ON uom.target_type = 'service' AND sc.id = uom.target_id
    LEFT JOIN public.products_catalog pc
        ON uom.target_type = 'product' AND pc.id = uom.target_id
    LEFT JOIN public.relationship_edges re
        ON re.tenant_id = uom.tenant_id
        AND re.user_id = uom.user_id
        AND re.target_type = uom.target_type
        AND re.target_id = uom.target_id
    WHERE uom.tenant_id = v_tenant_id
      AND uom.user_id = v_user_id
      AND (p_target_type IS NULL OR uom.target_type = p_target_type)
      AND (p_state IS NULL OR uom.state = p_state)
    LIMIT p_limit;

    -- Return success
    RETURN jsonb_build_object(
        'ok', true,
        'items', v_items,
        'query', jsonb_build_object(
            'limit', p_limit,
            'target_type', p_target_type,
            'state', p_state
        )
    );
END;
$$;

-- ===========================================================================
-- Permissions
-- ===========================================================================

-- RPC functions: callable by authenticated users
GRANT EXECUTE ON FUNCTION public.catalog_add_service(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.catalog_add_product(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.offers_set_state(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.offers_record_outcome(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.offers_get_recommendations(INT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.offers_get_memory(INT, TEXT, TEXT) TO authenticated;

-- Tables: allow authenticated users to interact (RLS will enforce row-level access)
GRANT SELECT, INSERT ON public.services_catalog TO authenticated;
GRANT SELECT, INSERT ON public.products_catalog TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.user_offers_memory TO authenticated;
GRANT SELECT, INSERT ON public.usage_outcomes TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.relationship_edges TO authenticated;

-- ===========================================================================
-- Comments
-- ===========================================================================

COMMENT ON TABLE public.services_catalog IS 'VTID-01092: Catalog of services available to users (coaches, doctors, labs, etc.)';
COMMENT ON TABLE public.products_catalog IS 'VTID-01092: Catalog of products available to users (supplements, devices, apps, etc.)';
COMMENT ON TABLE public.user_offers_memory IS 'VTID-01092: Tracks user relationship to services/products (viewed, saved, used, dismissed, rated)';
COMMENT ON TABLE public.usage_outcomes IS 'VTID-01092: User-stated outcomes from using services/products (deterministic, non-medical)';
COMMENT ON TABLE public.relationship_edges IS 'VTID-01092: Graph edges representing user relationships to entities (services, products, people)';

COMMENT ON FUNCTION public.catalog_add_service IS 'VTID-01092: Add a service to the catalog';
COMMENT ON FUNCTION public.catalog_add_product IS 'VTID-01092: Add a product to the catalog';
COMMENT ON FUNCTION public.offers_set_state IS 'VTID-01092: Set user state for a service/product and update relationship edge';
COMMENT ON FUNCTION public.offers_record_outcome IS 'VTID-01092: Record a perceived outcome from using a service/product';
COMMENT ON FUNCTION public.offers_get_recommendations IS 'VTID-01092: Get recommended services/products based on relationship strength';
COMMENT ON FUNCTION public.offers_get_memory IS 'VTID-01092: Get user offers memory with catalog details';
