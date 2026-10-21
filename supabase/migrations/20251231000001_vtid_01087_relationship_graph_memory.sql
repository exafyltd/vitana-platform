-- Migration: 20251231000001_vtid_01087_relationship_graph_memory.sql
-- Purpose: VTID-01087 Relationship Graph Memory - universal relationship graph for matchmaking
-- Date: 2025-12-31
--
-- Creates the relationship memory graph that captures:
--   - people <-> people
--   - people <-> groups
--   - people <-> events/meetups
--   - people <-> services
--   - people <-> products
--   - people <-> live rooms
--   - people <-> locations
--
-- This is the matchmaking spine of Vitana.
--
-- Dependencies:
--   - VTID-01101 (Phase A-Fix) - tenant/user/role helpers
--   - VTID-01102 (Phase B-Fix) - runtime context bridge
--   - VTID-01104 (Memory Core) - memory categories and items

-- ===========================================================================
-- A. relationship_nodes - Entities that can be connected
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.relationship_nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    node_type TEXT NOT NULL CHECK (
        node_type IN ('person', 'group', 'event', 'service', 'product', 'location', 'live_room')
    ),
    ref_id UUID NULL,  -- Points to actual table (profiles, groups, events, etc.)
    title TEXT NOT NULL CHECK (title != ''),
    domain TEXT NOT NULL DEFAULT 'community' CHECK (
        domain IN ('community', 'health', 'business', 'lifestyle')
    ),
    metadata JSONB NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_relationship_nodes_tenant_type
    ON public.relationship_nodes (tenant_id, node_type);

CREATE INDEX IF NOT EXISTS idx_relationship_nodes_tenant_domain
    ON public.relationship_nodes (tenant_id, domain);

CREATE INDEX IF NOT EXISTS idx_relationship_nodes_ref_id
    ON public.relationship_nodes (ref_id) WHERE ref_id IS NOT NULL;

-- ===========================================================================
-- B. relationship_edges - Connections between entities
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.relationship_edges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,  -- The owner of this relationship memory
    from_node_id UUID NOT NULL REFERENCES public.relationship_nodes(id) ON DELETE CASCADE,
    to_node_id UUID NOT NULL REFERENCES public.relationship_nodes(id) ON DELETE CASCADE,
    relationship_type TEXT NOT NULL CHECK (
        relationship_type IN ('friend', 'member', 'attendee', 'interested', 'using', 'visited', 'following')
    ),
    strength INT NOT NULL DEFAULT 10 CHECK (strength >= 0 AND strength <= 100),
    origin TEXT NOT NULL CHECK (
        origin IN ('diary', 'explicit', 'system', 'autopilot')
    ),
    context JSONB NULL DEFAULT '{}',  -- why/how the relationship was formed
    first_seen DATE NOT NULL DEFAULT CURRENT_DATE,
    last_seen DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Unique constraint: one edge per relationship type per user per node pair
    CONSTRAINT unique_user_edge UNIQUE (tenant_id, user_id, from_node_id, to_node_id, relationship_type)
);

-- Indexes for graph traversal
CREATE INDEX IF NOT EXISTS idx_relationship_edges_tenant_user
    ON public.relationship_edges (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_relationship_edges_from_node
    ON public.relationship_edges (from_node_id);

CREATE INDEX IF NOT EXISTS idx_relationship_edges_to_node
    ON public.relationship_edges (to_node_id);

CREATE INDEX IF NOT EXISTS idx_relationship_edges_tenant_user_type
    ON public.relationship_edges (tenant_id, user_id, relationship_type);

CREATE INDEX IF NOT EXISTS idx_relationship_edges_strength
    ON public.relationship_edges (strength DESC);

CREATE INDEX IF NOT EXISTS idx_relationship_edges_last_seen
    ON public.relationship_edges (last_seen DESC);

-- ===========================================================================
-- C. relationship_signals - Derived behavioral signals (not inferred)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.relationship_signals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    signal_key TEXT NOT NULL CHECK (signal_key != ''),
    confidence INT NOT NULL DEFAULT 50 CHECK (confidence >= 0 AND confidence <= 100),
    evidence JSONB NULL DEFAULT '{}',  -- Evidence supporting this signal
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Unique signal per user per key
    CONSTRAINT unique_user_signal UNIQUE (tenant_id, user_id, signal_key)
);

-- Indexes for signal lookup
CREATE INDEX IF NOT EXISTS idx_relationship_signals_tenant_user
    ON public.relationship_signals (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_relationship_signals_key
    ON public.relationship_signals (signal_key);

CREATE INDEX IF NOT EXISTS idx_relationship_signals_confidence
    ON public.relationship_signals (confidence DESC);

-- ===========================================================================
-- D. RLS Policies
-- ===========================================================================

-- Enable RLS on all tables
ALTER TABLE public.relationship_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.relationship_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.relationship_signals ENABLE ROW LEVEL SECURITY;

-- relationship_nodes: tenant isolation (nodes are shared within tenant)
DROP POLICY IF EXISTS relationship_nodes_select ON public.relationship_nodes;
CREATE POLICY relationship_nodes_select ON public.relationship_nodes
    FOR SELECT
    TO authenticated
    USING (tenant_id = public.current_tenant_id());

DROP POLICY IF EXISTS relationship_nodes_insert ON public.relationship_nodes;
CREATE POLICY relationship_nodes_insert ON public.relationship_nodes
    FOR INSERT
    TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id());

DROP POLICY IF EXISTS relationship_nodes_update ON public.relationship_nodes;
CREATE POLICY relationship_nodes_update ON public.relationship_nodes
    FOR UPDATE
    TO authenticated
    USING (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id());

DROP POLICY IF EXISTS relationship_nodes_delete ON public.relationship_nodes;
CREATE POLICY relationship_nodes_delete ON public.relationship_nodes
    FOR DELETE
    TO authenticated
    USING (tenant_id = public.current_tenant_id());

-- relationship_edges: user + tenant isolation
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

DROP POLICY IF EXISTS relationship_edges_delete ON public.relationship_edges;
CREATE POLICY relationship_edges_delete ON public.relationship_edges
    FOR DELETE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- relationship_signals: user + tenant isolation
DROP POLICY IF EXISTS relationship_signals_select ON public.relationship_signals;
CREATE POLICY relationship_signals_select ON public.relationship_signals
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS relationship_signals_insert ON public.relationship_signals;
CREATE POLICY relationship_signals_insert ON public.relationship_signals
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS relationship_signals_update ON public.relationship_signals;
CREATE POLICY relationship_signals_update ON public.relationship_signals
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

DROP POLICY IF EXISTS relationship_signals_delete ON public.relationship_signals;
CREATE POLICY relationship_signals_delete ON public.relationship_signals
    FOR DELETE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- ===========================================================================
-- E. RPC Functions
-- ===========================================================================

-- ===========================================================================
-- E.1 relationship_ensure_node - Get or create a relationship node
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.relationship_ensure_node(
    p_node_type TEXT,
    p_title TEXT,
    p_ref_id UUID DEFAULT NULL,
    p_domain TEXT DEFAULT 'community',
    p_metadata JSONB DEFAULT '{}'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_node_id UUID;
    v_existing_id UUID;
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

    -- Validate node_type
    IF p_node_type NOT IN ('person', 'group', 'event', 'service', 'product', 'location', 'live_room') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_NODE_TYPE',
            'message', 'node_type must be one of: person, group, event, service, product, location, live_room'
        );
    END IF;

    -- Validate domain
    IF p_domain NOT IN ('community', 'health', 'business', 'lifestyle') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_DOMAIN',
            'message', 'domain must be one of: community, health, business, lifestyle'
        );
    END IF;

    -- Validate title
    IF p_title IS NULL OR p_title = '' THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_TITLE',
            'message', 'title is required and cannot be empty'
        );
    END IF;

    -- Check if node already exists (by ref_id if provided, otherwise by title+type)
    IF p_ref_id IS NOT NULL THEN
        SELECT id INTO v_existing_id
        FROM public.relationship_nodes
        WHERE tenant_id = v_tenant_id
          AND node_type = p_node_type
          AND ref_id = p_ref_id
        LIMIT 1;
    ELSE
        SELECT id INTO v_existing_id
        FROM public.relationship_nodes
        WHERE tenant_id = v_tenant_id
          AND node_type = p_node_type
          AND title = p_title
        LIMIT 1;
    END IF;

    IF v_existing_id IS NOT NULL THEN
        RETURN jsonb_build_object(
            'ok', true,
            'id', v_existing_id,
            'created', false
        );
    END IF;

    -- Create new node
    INSERT INTO public.relationship_nodes (
        tenant_id,
        node_type,
        ref_id,
        title,
        domain,
        metadata
    ) VALUES (
        v_tenant_id,
        p_node_type,
        p_ref_id,
        p_title,
        p_domain,
        COALESCE(p_metadata, '{}'::JSONB)
    )
    RETURNING id INTO v_node_id;

    RETURN jsonb_build_object(
        'ok', true,
        'id', v_node_id,
        'created', true
    );
END;
$$;

-- ===========================================================================
-- E.2 relationship_add_edge - Create or strengthen a relationship edge
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.relationship_add_edge(
    p_from_node_id UUID,
    p_to_node_id UUID,
    p_relationship_type TEXT,
    p_origin TEXT,
    p_context JSONB DEFAULT '{}'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_edge_id UUID;
    v_existing_edge RECORD;
    v_new_strength INT;
    v_is_new BOOLEAN := false;
    v_from_node RECORD;
    v_to_node RECORD;
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

    -- Validate relationship_type
    IF p_relationship_type NOT IN ('friend', 'member', 'attendee', 'interested', 'using', 'visited', 'following') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_RELATIONSHIP_TYPE',
            'message', 'relationship_type must be one of: friend, member, attendee, interested, using, visited, following'
        );
    END IF;

    -- Validate origin
    IF p_origin NOT IN ('diary', 'explicit', 'system', 'autopilot') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_ORIGIN',
            'message', 'origin must be one of: diary, explicit, system, autopilot'
        );
    END IF;

    -- Verify from_node exists and belongs to tenant
    SELECT id, node_type, title INTO v_from_node
    FROM public.relationship_nodes
    WHERE id = p_from_node_id AND tenant_id = v_tenant_id;

    IF v_from_node.id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'FROM_NODE_NOT_FOUND',
            'message', 'from_node_id does not exist or is not accessible'
        );
    END IF;

    -- Verify to_node exists and belongs to tenant
    SELECT id, node_type, title INTO v_to_node
    FROM public.relationship_nodes
    WHERE id = p_to_node_id AND tenant_id = v_tenant_id;

    IF v_to_node.id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TO_NODE_NOT_FOUND',
            'message', 'to_node_id does not exist or is not accessible'
        );
    END IF;

    -- Check if edge already exists
    SELECT * INTO v_existing_edge
    FROM public.relationship_edges
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND from_node_id = p_from_node_id
      AND to_node_id = p_to_node_id
      AND relationship_type = p_relationship_type;

    IF v_existing_edge.id IS NOT NULL THEN
        -- Edge exists - strengthen it (deterministic: +5 per interaction, cap at 100)
        v_new_strength := LEAST(v_existing_edge.strength + 5, 100);

        UPDATE public.relationship_edges
        SET
            strength = v_new_strength,
            last_seen = CURRENT_DATE,
            context = COALESCE(p_context, context)
        WHERE id = v_existing_edge.id
        RETURNING id INTO v_edge_id;

        v_is_new := false;
    ELSE
        -- Create new edge with initial strength of 10
        INSERT INTO public.relationship_edges (
            tenant_id,
            user_id,
            from_node_id,
            to_node_id,
            relationship_type,
            strength,
            origin,
            context,
            first_seen,
            last_seen
        ) VALUES (
            v_tenant_id,
            v_user_id,
            p_from_node_id,
            p_to_node_id,
            p_relationship_type,
            10,  -- Initial strength
            p_origin,
            COALESCE(p_context, '{}'::JSONB),
            CURRENT_DATE,
            CURRENT_DATE
        )
        RETURNING id INTO v_edge_id;

        v_new_strength := 10;
        v_is_new := true;
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'edge_id', v_edge_id,
        'created', v_is_new,
        'strength', v_new_strength,
        'from_node', jsonb_build_object(
            'id', v_from_node.id,
            'type', v_from_node.node_type,
            'title', v_from_node.title
        ),
        'to_node', jsonb_build_object(
            'id', v_to_node.id,
            'type', v_to_node.node_type,
            'title', v_to_node.title
        )
    );
END;
$$;

-- ===========================================================================
-- E.3 relationship_get_graph - Get filtered relationship graph for user
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.relationship_get_graph(
    p_domain TEXT DEFAULT NULL,
    p_node_types TEXT[] DEFAULT NULL,
    p_relationship_types TEXT[] DEFAULT NULL,
    p_min_strength INT DEFAULT 0,
    p_limit INT DEFAULT 100
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_edges JSONB;
    v_nodes JSONB;
    v_node_ids UUID[];
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
        p_limit := 100;
    ELSIF p_limit > 500 THEN
        p_limit := 500;
    END IF;

    -- Cap min_strength
    IF p_min_strength IS NULL OR p_min_strength < 0 THEN
        p_min_strength := 0;
    END IF;

    -- Get edges with optional filters
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', e.id,
                'from_node_id', e.from_node_id,
                'to_node_id', e.to_node_id,
                'relationship_type', e.relationship_type,
                'strength', e.strength,
                'origin', e.origin,
                'context', e.context,
                'first_seen', e.first_seen,
                'last_seen', e.last_seen
            )
            ORDER BY e.strength DESC, e.last_seen DESC
        ),
        '[]'::JSONB
    ),
    ARRAY_AGG(DISTINCT e.from_node_id) || ARRAY_AGG(DISTINCT e.to_node_id)
    INTO v_edges, v_node_ids
    FROM public.relationship_edges e
    JOIN public.relationship_nodes fn ON e.from_node_id = fn.id
    JOIN public.relationship_nodes tn ON e.to_node_id = tn.id
    WHERE e.tenant_id = v_tenant_id
      AND e.user_id = v_user_id
      AND e.strength >= p_min_strength
      AND (p_domain IS NULL OR fn.domain = p_domain OR tn.domain = p_domain)
      AND (p_node_types IS NULL OR fn.node_type = ANY(p_node_types) OR tn.node_type = ANY(p_node_types))
      AND (p_relationship_types IS NULL OR e.relationship_type = ANY(p_relationship_types))
    LIMIT p_limit;

    -- Get node details for all referenced nodes
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', n.id,
                'node_type', n.node_type,
                'ref_id', n.ref_id,
                'title', n.title,
                'domain', n.domain,
                'metadata', n.metadata
            )
        ),
        '[]'::JSONB
    )
    INTO v_nodes
    FROM public.relationship_nodes n
    WHERE n.id = ANY(v_node_ids);

    RETURN jsonb_build_object(
        'ok', true,
        'edges', v_edges,
        'nodes', v_nodes,
        'query', jsonb_build_object(
            'domain', p_domain,
            'node_types', p_node_types,
            'relationship_types', p_relationship_types,
            'min_strength', p_min_strength,
            'limit', p_limit
        )
    );
END;
$$;

-- ===========================================================================
-- E.4 relationship_update_signal - Create or update a user signal
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.relationship_update_signal(
    p_signal_key TEXT,
    p_confidence INT,
    p_evidence JSONB DEFAULT '{}'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_signal_id UUID;
    v_is_new BOOLEAN := false;
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

    -- Validate signal_key
    IF p_signal_key IS NULL OR p_signal_key = '' THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_SIGNAL_KEY',
            'message', 'signal_key is required and cannot be empty'
        );
    END IF;

    -- Validate confidence
    IF p_confidence IS NULL OR p_confidence < 0 OR p_confidence > 100 THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_CONFIDENCE',
            'message', 'confidence must be between 0 and 100'
        );
    END IF;

    -- Upsert signal
    INSERT INTO public.relationship_signals (
        tenant_id,
        user_id,
        signal_key,
        confidence,
        evidence,
        updated_at
    ) VALUES (
        v_tenant_id,
        v_user_id,
        p_signal_key,
        p_confidence,
        COALESCE(p_evidence, '{}'::JSONB),
        NOW()
    )
    ON CONFLICT (tenant_id, user_id, signal_key) DO UPDATE SET
        confidence = EXCLUDED.confidence,
        evidence = EXCLUDED.evidence,
        updated_at = NOW()
    RETURNING id, (xmax = 0) INTO v_signal_id, v_is_new;

    RETURN jsonb_build_object(
        'ok', true,
        'signal_id', v_signal_id,
        'signal_key', p_signal_key,
        'confidence', p_confidence,
        'created', v_is_new
    );
END;
$$;

-- ===========================================================================
-- E.5 relationship_get_signals - Get signals for current user
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.relationship_get_signals(
    p_min_confidence INT DEFAULT 0,
    p_signal_keys TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_signals JSONB;
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

    -- Get signals with optional filters
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', s.id,
                'signal_key', s.signal_key,
                'confidence', s.confidence,
                'evidence', s.evidence,
                'updated_at', s.updated_at
            )
            ORDER BY s.confidence DESC, s.updated_at DESC
        ),
        '[]'::JSONB
    )
    INTO v_signals
    FROM public.relationship_signals s
    WHERE s.tenant_id = v_tenant_id
      AND s.user_id = v_user_id
      AND s.confidence >= COALESCE(p_min_confidence, 0)
      AND (p_signal_keys IS NULL OR s.signal_key = ANY(p_signal_keys));

    RETURN jsonb_build_object(
        'ok', true,
        'signals', v_signals
    );
END;
$$;

-- ===========================================================================
-- F. Permissions
-- ===========================================================================

-- RPC functions: callable by authenticated users
GRANT EXECUTE ON FUNCTION public.relationship_ensure_node(TEXT, TEXT, UUID, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.relationship_add_edge(UUID, UUID, TEXT, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.relationship_get_graph(TEXT, TEXT[], TEXT[], INT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.relationship_update_signal(TEXT, INT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.relationship_get_signals(INT, TEXT[]) TO authenticated;

-- Tables: allow authenticated users to interact (RLS enforces row-level access)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.relationship_nodes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.relationship_edges TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.relationship_signals TO authenticated;

-- Service role: full access for backend operations
GRANT ALL ON public.relationship_nodes TO service_role;
GRANT ALL ON public.relationship_edges TO service_role;
GRANT ALL ON public.relationship_signals TO service_role;

-- ===========================================================================
-- G. Comments
-- ===========================================================================

COMMENT ON TABLE public.relationship_nodes IS 'VTID-01087: Universal relationship graph nodes - entities that can be connected (people, groups, events, services, products, locations, live_rooms)';
COMMENT ON TABLE public.relationship_edges IS 'VTID-01087: Relationship graph edges - connections between entities with strength, origin, and context';
COMMENT ON TABLE public.relationship_signals IS 'VTID-01087: Derived behavioral signals for matchmaking (e.g., prefers_small_groups, likes_walking_meetups)';

COMMENT ON FUNCTION public.relationship_ensure_node IS 'VTID-01087: Get or create a relationship node by type/title or ref_id';
COMMENT ON FUNCTION public.relationship_add_edge IS 'VTID-01087: Create or strengthen a relationship edge - strength grows with repeated interactions';
COMMENT ON FUNCTION public.relationship_get_graph IS 'VTID-01087: Retrieve filtered relationship graph for the current user';
COMMENT ON FUNCTION public.relationship_update_signal IS 'VTID-01087: Create or update a user behavioral signal for matchmaking';
COMMENT ON FUNCTION public.relationship_get_signals IS 'VTID-01087: Get behavioral signals for the current user';
