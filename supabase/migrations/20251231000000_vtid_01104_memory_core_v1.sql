-- Migration: 20251231000000_vtid_01104_memory_core_v1.sql
-- Purpose: VTID-01104 Memory Core v1 - tables, RLS, minimal RPC
-- Date: 2025-12-31
--
-- Creates the minimal long-term memory core for ORB to persist conversations and categories.
-- Deterministic v1 only - no embeddings, no LLM categorization.
--
-- Dependencies:
--   - VTID-01101 (Phase A-Fix) - tenant/user/role helpers
--   - VTID-01102 (Phase B-Fix) - runtime context bridge

-- ===========================================================================
-- 3.1.A memory_categories - Deterministic category lookup table
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.memory_categories (
    key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed category keys (deterministic, exact strings)
INSERT INTO public.memory_categories (key, label) VALUES
    ('conversation', 'Conversation'),
    ('health', 'Health'),
    ('relationships', 'Relationships'),
    ('community', 'Community'),
    ('preferences', 'Preferences'),
    ('goals', 'Goals'),
    ('tasks', 'Tasks'),
    ('products_services', 'Products & Services'),
    ('events_meetups', 'Events & Meetups'),
    ('notes', 'Notes')
ON CONFLICT (key) DO NOTHING;

-- ===========================================================================
-- 3.1.B memory_items - Long-term memory storage
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.memory_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    active_role TEXT NULL,  -- stored for audit; not used in RLS
    category_key TEXT NOT NULL REFERENCES public.memory_categories(key),
    source TEXT NOT NULL CHECK (source IN ('orb_text', 'orb_voice', 'diary', 'upload', 'system')),
    content TEXT NOT NULL CHECK (content != ''),
    content_json JSONB NULL,
    importance INT NOT NULL DEFAULT 10 CHECK (importance >= 0 AND importance <= 100),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_memory_items_tenant_user_occurred
    ON public.memory_items (tenant_id, user_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_items_tenant_user_category_occurred
    ON public.memory_items (tenant_id, user_id, category_key, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_items_tenant_created
    ON public.memory_items (tenant_id, created_at DESC);

-- ===========================================================================
-- 3.2 RLS Policies
-- ===========================================================================

-- Enable RLS on both tables
ALTER TABLE public.memory_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_items ENABLE ROW LEVEL SECURITY;

-- memory_categories: Allow SELECT to all authenticated users (read-only lookup table)
DROP POLICY IF EXISTS memory_categories_select ON public.memory_categories;
CREATE POLICY memory_categories_select ON public.memory_categories
    FOR SELECT
    TO authenticated
    USING (true);

-- memory_items: Allow access only when tenant_id=current_tenant_id() AND user_id=auth.uid()
DROP POLICY IF EXISTS memory_items_select ON public.memory_items;
CREATE POLICY memory_items_select ON public.memory_items
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS memory_items_insert ON public.memory_items;
CREATE POLICY memory_items_insert ON public.memory_items
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS memory_items_update ON public.memory_items;
CREATE POLICY memory_items_update ON public.memory_items
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

DROP POLICY IF EXISTS memory_items_delete ON public.memory_items;
CREATE POLICY memory_items_delete ON public.memory_items
    FOR DELETE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- ===========================================================================
-- 3.3 Minimal RPC: memory_write_item
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.memory_write_item(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_active_role TEXT;
    v_category_key TEXT;
    v_source TEXT;
    v_content TEXT;
    v_content_json JSONB;
    v_importance INT;
    v_occurred_at TIMESTAMPTZ;
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

    -- Derive active_role (optional, for audit)
    v_active_role := public.current_active_role();

    -- Extract payload fields
    v_category_key := COALESCE(p_payload->>'category_key', 'conversation');
    v_source := p_payload->>'source';
    v_content := p_payload->>'content';
    v_content_json := p_payload->'content_json';
    v_importance := COALESCE((p_payload->>'importance')::INT, 10);
    v_occurred_at := COALESCE((p_payload->>'occurred_at')::TIMESTAMPTZ, NOW());

    -- Validate required fields
    IF v_source IS NULL OR v_source = '' THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_SOURCE',
            'message', 'source is required'
        );
    END IF;

    IF v_source NOT IN ('orb_text', 'orb_voice', 'diary', 'upload', 'system') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_SOURCE',
            'message', 'source must be one of: orb_text, orb_voice, diary, upload, system'
        );
    END IF;

    IF v_content IS NULL OR v_content = '' THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_CONTENT',
            'message', 'content is required and cannot be empty'
        );
    END IF;

    -- Validate category exists
    IF NOT EXISTS (SELECT 1 FROM public.memory_categories WHERE key = v_category_key AND is_active = true) THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_CATEGORY',
            'message', 'category_key does not exist or is not active'
        );
    END IF;

    -- Validate importance range
    IF v_importance < 0 OR v_importance > 100 THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_IMPORTANCE',
            'message', 'importance must be between 0 and 100'
        );
    END IF;

    -- Insert the memory item
    INSERT INTO public.memory_items (
        tenant_id,
        user_id,
        active_role,
        category_key,
        source,
        content,
        content_json,
        importance,
        occurred_at
    ) VALUES (
        v_tenant_id,
        v_user_id,
        v_active_role,
        v_category_key,
        v_source,
        v_content,
        v_content_json,
        v_importance,
        v_occurred_at
    )
    RETURNING id INTO v_new_id;

    -- Return success
    RETURN jsonb_build_object(
        'ok', true,
        'id', v_new_id,
        'category_key', v_category_key,
        'occurred_at', v_occurred_at
    );
END;
$$;

-- ===========================================================================
-- 3.3 Minimal RPC: memory_get_context
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.memory_get_context(
    p_limit INT DEFAULT 20,
    p_categories TEXT[] DEFAULT NULL,
    p_since TIMESTAMPTZ DEFAULT NULL
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

    -- Cap limit to reasonable bounds
    IF p_limit IS NULL OR p_limit < 1 THEN
        p_limit := 20;
    ELSIF p_limit > 100 THEN
        p_limit := 100;
    END IF;

    -- Query memory items with optional filters
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', mi.id,
                'category_key', mi.category_key,
                'source', mi.source,
                'content', mi.content,
                'occurred_at', mi.occurred_at,
                'importance', mi.importance
            )
            ORDER BY mi.occurred_at DESC
        ),
        '[]'::JSONB
    )
    INTO v_items
    FROM public.memory_items mi
    WHERE mi.tenant_id = v_tenant_id
      AND mi.user_id = v_user_id
      AND (p_categories IS NULL OR mi.category_key = ANY(p_categories))
      AND (p_since IS NULL OR mi.occurred_at >= p_since)
    LIMIT p_limit;

    -- Return success with items
    RETURN jsonb_build_object(
        'ok', true,
        'items', v_items
    );
END;
$$;

-- ===========================================================================
-- Permissions
-- ===========================================================================

-- RPC functions: callable by authenticated users
GRANT EXECUTE ON FUNCTION public.memory_write_item(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.memory_get_context(INT, TEXT[], TIMESTAMPTZ) TO authenticated;

-- Tables: allow authenticated users to interact (RLS will enforce row-level access)
GRANT SELECT ON public.memory_categories TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memory_items TO authenticated;

-- ===========================================================================
-- Comments
-- ===========================================================================

COMMENT ON TABLE public.memory_categories IS 'VTID-01104: Deterministic category lookup table for memory items';
COMMENT ON TABLE public.memory_items IS 'VTID-01104: Long-term memory storage for ORB conversations and user data';
COMMENT ON FUNCTION public.memory_write_item IS 'VTID-01104: Write a memory item for the current authenticated user';
COMMENT ON FUNCTION public.memory_get_context IS 'VTID-01104: Retrieve recent memory items for the current authenticated user with optional filters';
