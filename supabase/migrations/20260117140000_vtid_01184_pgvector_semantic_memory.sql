-- Migration: 20260117140000_vtid_01184_pgvector_semantic_memory.sql
-- Purpose: VTID-01184 Phase 1A - Supabase-First Semantic Memory with pgvector
-- Date: 2026-01-17
--
-- Implements:
--   1. pgvector extension for vector similarity search
--   2. Embedding columns on memory_items (additive only)
--   3. workspace_scope and provenance columns for Active Context Lens
--   4. HNSW index for fast similarity search
--   5. Tenant-safe similarity search RPC with hard filters
--
-- Dependencies:
--   - VTID-01104 (Memory Core v1) - memory_items table
--
-- GOVERNANCE:
--   - Additive-only changes (no breaking changes)
--   - Hard filters: tenant_id, user_id, workspace_scope, active_role
--   - SECURITY INVOKER for RPC functions

-- ===========================================================================
-- 1. Enable pgvector Extension
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ===========================================================================
-- 2. Add Embedding Columns to memory_items (Additive)
-- ===========================================================================

-- Embedding vector (1536 dimensions for OpenAI text-embedding-3-small/large,
-- 384 for all-MiniLM-L6-v2, configurable via embedding_model)
-- Using 1536 as default for compatibility with common models
ALTER TABLE public.memory_items
ADD COLUMN IF NOT EXISTS embedding vector(1536) NULL;

ALTER TABLE public.memory_items
ADD COLUMN IF NOT EXISTS embedding_model text NULL;

ALTER TABLE public.memory_items
ADD COLUMN IF NOT EXISTS embedding_updated_at timestamptz NULL;

-- ===========================================================================
-- 3. Add workspace_scope and Provenance Columns (Additive)
-- ===========================================================================

-- workspace_scope: 'product' (production) or 'dev' (development/testing)
ALTER TABLE public.memory_items
ADD COLUMN IF NOT EXISTS workspace_scope text NULL
CHECK (workspace_scope IS NULL OR workspace_scope IN ('product', 'dev'));

-- Provenance fields for traceability
ALTER TABLE public.memory_items
ADD COLUMN IF NOT EXISTS vtid text NULL;

ALTER TABLE public.memory_items
ADD COLUMN IF NOT EXISTS origin_service text NULL;

ALTER TABLE public.memory_items
ADD COLUMN IF NOT EXISTS conversation_id uuid NULL;

-- Visibility/consent scope for privacy controls
ALTER TABLE public.memory_items
ADD COLUMN IF NOT EXISTS visibility_scope text NULL DEFAULT 'private'
CHECK (visibility_scope IN ('private', 'shared', 'public'));

-- ===========================================================================
-- 4. Create HNSW Index for Fast Similarity Search
-- ===========================================================================

-- HNSW index with cosine distance operator for semantic search
-- Using reasonable defaults: m=16, ef_construction=64
CREATE INDEX IF NOT EXISTS idx_memory_items_embedding_hnsw
ON public.memory_items
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Composite index for filtered similarity queries
-- This helps when filtering by tenant + workspace before vector search
CREATE INDEX IF NOT EXISTS idx_memory_items_tenant_workspace_embedding
ON public.memory_items (tenant_id, workspace_scope)
WHERE embedding IS NOT NULL;

-- Index for finding items needing embeddings
CREATE INDEX IF NOT EXISTS idx_memory_items_needs_embedding
ON public.memory_items (created_at)
WHERE embedding IS NULL;

-- ===========================================================================
-- 5. Active Context Lens Type
-- ===========================================================================

-- Drop existing type if needed (for idempotent migrations)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'context_lens') THEN
        CREATE TYPE public.context_lens AS (
            tenant_id uuid,
            user_id uuid,
            workspace_scope text,
            active_role text,
            allowed_categories text[],
            visibility_scope text,
            max_age_hours int
        );
    END IF;
END $$;

-- ===========================================================================
-- 6. Tenant-Safe Similarity Search RPC
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.memory_semantic_search(
    p_query_embedding vector(1536),
    p_top_k int DEFAULT 10,
    -- Hard filters (MANDATORY)
    p_tenant_id uuid DEFAULT NULL,
    p_user_id uuid DEFAULT NULL,
    p_workspace_scope text DEFAULT NULL,
    p_active_role text DEFAULT NULL,
    -- Optional filters
    p_categories text[] DEFAULT NULL,
    p_visibility_scope text DEFAULT 'private',
    p_max_age_hours int DEFAULT NULL,
    p_recency_boost boolean DEFAULT true
)
RETURNS TABLE (
    id uuid,
    content text,
    content_json jsonb,
    category_key text,
    source text,
    importance int,
    occurred_at timestamptz,
    created_at timestamptz,
    active_role text,
    workspace_scope text,
    visibility_scope text,
    vtid text,
    origin_service text,
    conversation_id uuid,
    similarity_score float8,
    recency_score float8,
    combined_score float8
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_tenant_id uuid;
    v_user_id uuid;
    v_cutoff_time timestamptz;
BEGIN
    -- ===========================================================================
    -- HARD FILTER ENFORCEMENT: tenant_id and user_id are MANDATORY
    -- ===========================================================================

    -- Derive tenant_id from parameter or context
    v_tenant_id := COALESCE(p_tenant_id, public.current_tenant_id());
    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'TENANT_REQUIRED: tenant_id must be provided or derivable from context';
    END IF;

    -- Derive user_id from parameter or auth
    v_user_id := COALESCE(p_user_id, auth.uid());
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'USER_REQUIRED: user_id must be provided or derivable from auth context';
    END IF;

    -- Calculate cutoff time if max_age_hours specified
    IF p_max_age_hours IS NOT NULL AND p_max_age_hours > 0 THEN
        v_cutoff_time := NOW() - (p_max_age_hours || ' hours')::interval;
    END IF;

    -- ===========================================================================
    -- SEMANTIC SEARCH with Hard Filters + Optional Recency Boost
    -- ===========================================================================

    RETURN QUERY
    WITH filtered_items AS (
        SELECT
            mi.id,
            mi.content,
            mi.content_json,
            mi.category_key,
            mi.source,
            mi.importance,
            mi.occurred_at,
            mi.created_at,
            mi.active_role,
            mi.workspace_scope,
            mi.visibility_scope,
            mi.vtid,
            mi.origin_service,
            mi.conversation_id,
            mi.embedding,
            -- Cosine similarity (1 - cosine distance)
            1 - (mi.embedding <=> p_query_embedding) AS similarity
        FROM public.memory_items mi
        WHERE
            -- HARD FILTERS (always enforced)
            mi.tenant_id = v_tenant_id
            AND mi.user_id = v_user_id
            AND mi.embedding IS NOT NULL
            -- workspace_scope filter (if specified)
            AND (p_workspace_scope IS NULL OR mi.workspace_scope = p_workspace_scope OR mi.workspace_scope IS NULL)
            -- active_role filter (if specified, matches or NULL)
            AND (p_active_role IS NULL OR mi.active_role = p_active_role OR mi.active_role IS NULL)
            -- category filter (if specified)
            AND (p_categories IS NULL OR mi.category_key = ANY(p_categories))
            -- visibility filter
            AND (mi.visibility_scope IS NULL OR mi.visibility_scope = p_visibility_scope OR p_visibility_scope = 'public')
            -- time filter (if specified)
            AND (v_cutoff_time IS NULL OR mi.occurred_at >= v_cutoff_time)
    ),
    scored_items AS (
        SELECT
            fi.*,
            -- Recency score: exponential decay based on age (0-1 range)
            CASE
                WHEN p_recency_boost THEN
                    EXP(-EXTRACT(EPOCH FROM (NOW() - fi.occurred_at)) / (7 * 24 * 3600))  -- 7-day half-life
                ELSE 1.0
            END AS recency
        FROM filtered_items fi
    )
    SELECT
        si.id,
        si.content,
        si.content_json,
        si.category_key,
        si.source,
        si.importance,
        si.occurred_at,
        si.created_at,
        si.active_role,
        si.workspace_scope,
        si.visibility_scope,
        si.vtid,
        si.origin_service,
        si.conversation_id,
        si.similarity AS similarity_score,
        si.recency AS recency_score,
        -- Combined score: 70% similarity + 30% recency (adjustable)
        (0.7 * si.similarity + 0.3 * si.recency) AS combined_score
    FROM scored_items si
    ORDER BY combined_score DESC
    LIMIT p_top_k;
END;
$$;

-- ===========================================================================
-- 7. Memory Write with Embeddings RPC (Enhanced version)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.memory_write_item_v2(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_active_role TEXT;
    v_workspace_scope TEXT;
    v_category_key TEXT;
    v_source TEXT;
    v_content TEXT;
    v_content_json JSONB;
    v_importance INT;
    v_occurred_at TIMESTAMPTZ;
    v_vtid TEXT;
    v_origin_service TEXT;
    v_conversation_id UUID;
    v_visibility_scope TEXT;
    v_embedding vector(1536);
    v_embedding_model TEXT;
    v_new_id UUID;
BEGIN
    -- Derive tenant_id from context or payload
    v_tenant_id := COALESCE(
        (p_payload->>'tenant_id')::UUID,
        public.current_tenant_id()
    );
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TENANT_NOT_FOUND',
            'message', 'Unable to determine tenant_id from request context or payload'
        );
    END IF;

    -- Derive user_id from auth or payload (for system writes)
    v_user_id := COALESCE(
        (p_payload->>'user_id')::UUID,
        auth.uid()
    );
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'USER_NOT_FOUND',
            'message', 'No authenticated user or user_id in payload'
        );
    END IF;

    -- Extract all fields from payload
    v_active_role := COALESCE(p_payload->>'active_role', public.current_active_role());
    v_workspace_scope := COALESCE(p_payload->>'workspace_scope', 'product');
    v_category_key := COALESCE(p_payload->>'category_key', 'conversation');
    v_source := p_payload->>'source';
    v_content := p_payload->>'content';
    v_content_json := p_payload->'content_json';
    v_importance := COALESCE((p_payload->>'importance')::INT, 10);
    v_occurred_at := COALESCE((p_payload->>'occurred_at')::TIMESTAMPTZ, NOW());
    v_vtid := p_payload->>'vtid';
    v_origin_service := p_payload->>'origin_service';
    v_conversation_id := (p_payload->>'conversation_id')::UUID;
    v_visibility_scope := COALESCE(p_payload->>'visibility_scope', 'private');

    -- Handle embedding if provided (for pre-computed embeddings)
    IF p_payload ? 'embedding' AND p_payload->>'embedding' IS NOT NULL THEN
        v_embedding := (p_payload->>'embedding')::vector(1536);
        v_embedding_model := p_payload->>'embedding_model';
    END IF;

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

    -- Validate workspace_scope
    IF v_workspace_scope NOT IN ('product', 'dev') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_WORKSPACE_SCOPE',
            'message', 'workspace_scope must be one of: product, dev'
        );
    END IF;

    -- Validate visibility_scope
    IF v_visibility_scope NOT IN ('private', 'shared', 'public') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_VISIBILITY_SCOPE',
            'message', 'visibility_scope must be one of: private, shared, public'
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

    -- Insert the memory item with all new columns
    INSERT INTO public.memory_items (
        tenant_id,
        user_id,
        active_role,
        workspace_scope,
        category_key,
        source,
        content,
        content_json,
        importance,
        occurred_at,
        vtid,
        origin_service,
        conversation_id,
        visibility_scope,
        embedding,
        embedding_model,
        embedding_updated_at
    ) VALUES (
        v_tenant_id,
        v_user_id,
        v_active_role,
        v_workspace_scope,
        v_category_key,
        v_source,
        v_content,
        v_content_json,
        v_importance,
        v_occurred_at,
        v_vtid,
        v_origin_service,
        v_conversation_id,
        v_visibility_scope,
        v_embedding,
        v_embedding_model,
        CASE WHEN v_embedding IS NOT NULL THEN NOW() ELSE NULL END
    )
    RETURNING id INTO v_new_id;

    -- Return success
    RETURN jsonb_build_object(
        'ok', true,
        'id', v_new_id,
        'tenant_id', v_tenant_id,
        'user_id', v_user_id,
        'category_key', v_category_key,
        'workspace_scope', v_workspace_scope,
        'occurred_at', v_occurred_at,
        'has_embedding', v_embedding IS NOT NULL
    );
END;
$$;

-- ===========================================================================
-- 8. Batch Update Embeddings RPC (for embedding pipeline)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.memory_update_embeddings(
    p_updates JSONB  -- Array of {id, embedding, embedding_model}
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_update JSONB;
    v_updated_count INT := 0;
    v_item_id UUID;
    v_embedding vector(1536);
    v_embedding_model TEXT;
BEGIN
    -- Process each update
    FOR v_update IN SELECT * FROM jsonb_array_elements(p_updates)
    LOOP
        v_item_id := (v_update->>'id')::UUID;
        v_embedding := (v_update->>'embedding')::vector(1536);
        v_embedding_model := v_update->>'embedding_model';

        UPDATE public.memory_items
        SET
            embedding = v_embedding,
            embedding_model = v_embedding_model,
            embedding_updated_at = NOW()
        WHERE id = v_item_id;

        IF FOUND THEN
            v_updated_count := v_updated_count + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'ok', true,
        'updated_count', v_updated_count,
        'requested_count', jsonb_array_length(p_updates)
    );
END;
$$;

-- ===========================================================================
-- 9. Get Items Needing Embeddings RPC (for embedding pipeline)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.memory_get_items_needing_embeddings(
    p_limit int DEFAULT 100,
    p_tenant_id uuid DEFAULT NULL,
    p_category_key text DEFAULT NULL,
    p_since timestamptz DEFAULT NULL
)
RETURNS TABLE (
    id uuid,
    content text,
    category_key text,
    tenant_id uuid,
    user_id uuid,
    created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT
        mi.id,
        mi.content,
        mi.category_key,
        mi.tenant_id,
        mi.user_id,
        mi.created_at
    FROM public.memory_items mi
    WHERE
        mi.embedding IS NULL
        AND (p_tenant_id IS NULL OR mi.tenant_id = p_tenant_id)
        AND (p_category_key IS NULL OR mi.category_key = p_category_key)
        AND (p_since IS NULL OR mi.created_at >= p_since)
    ORDER BY mi.created_at ASC
    LIMIT p_limit;
END;
$$;

-- ===========================================================================
-- 10. Admin Re-embed Trigger RPC
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.memory_mark_for_reembed(
    p_tenant_id uuid DEFAULT NULL,
    p_user_id uuid DEFAULT NULL,
    p_category_key text DEFAULT NULL,
    p_since timestamptz DEFAULT NULL,
    p_until timestamptz DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_updated_count INT;
BEGIN
    -- Clear embeddings for matching items (they will be regenerated by the pipeline)
    UPDATE public.memory_items
    SET
        embedding = NULL,
        embedding_model = NULL,
        embedding_updated_at = NULL
    WHERE
        (p_tenant_id IS NULL OR tenant_id = p_tenant_id)
        AND (p_user_id IS NULL OR user_id = p_user_id)
        AND (p_category_key IS NULL OR category_key = p_category_key)
        AND (p_since IS NULL OR created_at >= p_since)
        AND (p_until IS NULL OR created_at <= p_until);

    GET DIAGNOSTICS v_updated_count = ROW_COUNT;

    RETURN jsonb_build_object(
        'ok', true,
        'marked_for_reembed', v_updated_count,
        'filters', jsonb_build_object(
            'tenant_id', p_tenant_id,
            'user_id', p_user_id,
            'category_key', p_category_key,
            'since', p_since,
            'until', p_until
        )
    );
END;
$$;

-- ===========================================================================
-- 11. Permissions
-- ===========================================================================

-- RPC functions: callable by authenticated users
GRANT EXECUTE ON FUNCTION public.memory_semantic_search(
    vector(1536), int, uuid, uuid, text, text, text[], text, int, boolean
) TO authenticated;

GRANT EXECUTE ON FUNCTION public.memory_write_item_v2(JSONB) TO authenticated;

-- Service role only for batch operations
GRANT EXECUTE ON FUNCTION public.memory_update_embeddings(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.memory_get_items_needing_embeddings(int, uuid, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.memory_mark_for_reembed(uuid, uuid, text, timestamptz, timestamptz) TO service_role;

-- ===========================================================================
-- 12. Comments
-- ===========================================================================

COMMENT ON FUNCTION public.memory_semantic_search IS
'VTID-01184: Tenant-safe semantic similarity search with hard filters (tenant_id, user_id, workspace_scope, active_role) and optional recency boost';

COMMENT ON FUNCTION public.memory_write_item_v2 IS
'VTID-01184: Enhanced memory write with embedding columns, workspace_scope, and provenance tracking';

COMMENT ON FUNCTION public.memory_update_embeddings IS
'VTID-01184: Batch update embeddings for memory items (service_role only)';

COMMENT ON FUNCTION public.memory_get_items_needing_embeddings IS
'VTID-01184: Get memory items that need embeddings generated (service_role only)';

COMMENT ON FUNCTION public.memory_mark_for_reembed IS
'VTID-01184: Admin trigger to mark items for re-embedding by clearing existing embeddings (service_role only)';
