-- =============================================================================
-- VTID-01225: Fix embedding dimensions from 1536 to 768
--
-- text-embedding-004 (Gemini) only supports up to 768 dimensions.
-- 1536 was from OpenAI text-embedding-3-small which is not used in production.
-- No memory_facts embeddings exist yet, so this is a clean change.
--
-- Changes:
-- 1. ALTER memory_facts.embedding from vector(1536) to vector(768)
-- 2. Recreate HNSW index for vector(768)
-- 3. Recreate memory_facts_semantic_search() RPC with vector(768) parameter
-- 4. ALTER memory_items.embedding from vector(1536) to vector(768)
-- 5. Recreate memory_items semantic RPCs with vector(768) parameters
-- =============================================================================

-- ===========================================================================
-- 1. Fix memory_facts embedding column
-- ===========================================================================

-- Drop the existing HNSW index first
DROP INDEX IF EXISTS idx_memory_facts_embedding_hnsw;

-- Clear any embeddings that might be wrong dimension (shouldn't exist yet)
UPDATE public.memory_facts SET embedding = NULL WHERE embedding IS NOT NULL;

-- Change column type
ALTER TABLE public.memory_facts
  ALTER COLUMN embedding TYPE vector(768);

-- Recreate HNSW index for 768 dimensions
CREATE INDEX IF NOT EXISTS idx_memory_facts_embedding_hnsw
ON public.memory_facts
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- ===========================================================================
-- 2. Fix memory_facts_semantic_search() RPC
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.memory_facts_semantic_search(
  p_query_embedding vector(768),
  p_top_k int DEFAULT 20,
  p_tenant_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_entity text DEFAULT NULL,
  p_min_confidence numeric DEFAULT 0.0
)
RETURNS TABLE (
  id uuid,
  fact_key text,
  fact_value text,
  entity text,
  fact_value_type text,
  provenance_source text,
  provenance_confidence numeric,
  extracted_at timestamptz,
  similarity_score float8
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_tenant_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'tenant_id and user_id are required for memory_facts_semantic_search';
  END IF;

  RETURN QUERY
  SELECT
    mf.id,
    mf.fact_key,
    mf.fact_value,
    mf.entity,
    mf.fact_value_type,
    mf.provenance_source,
    mf.provenance_confidence,
    mf.extracted_at,
    1 - (mf.embedding <=> p_query_embedding) AS similarity_score
  FROM memory_facts mf
  WHERE mf.tenant_id = p_tenant_id
    AND mf.user_id = p_user_id
    AND mf.superseded_by IS NULL
    AND mf.embedding IS NOT NULL
    AND (p_entity IS NULL OR mf.entity = p_entity)
    AND mf.provenance_confidence >= p_min_confidence
  ORDER BY mf.embedding <=> p_query_embedding
  LIMIT p_top_k;
END;
$$;

-- Fix permissions (must re-grant after CREATE OR REPLACE with different signature)
DROP FUNCTION IF EXISTS public.memory_facts_semantic_search(vector(1536), int, uuid, uuid, text, numeric);

GRANT EXECUTE ON FUNCTION public.memory_facts_semantic_search(
  vector(768), int, uuid, uuid, text, numeric
) TO authenticated;

-- ===========================================================================
-- 3. Fix memory_items embedding column
-- ===========================================================================

-- Drop existing memory_items HNSW index
DROP INDEX IF EXISTS idx_memory_items_embedding_hnsw;

-- Clear any existing embeddings (they were 1536-dim, incompatible)
UPDATE public.memory_items SET embedding = NULL WHERE embedding IS NOT NULL;

-- Change column type
ALTER TABLE public.memory_items
  ALTER COLUMN embedding TYPE vector(768);

-- Recreate HNSW index for 768 dimensions
CREATE INDEX IF NOT EXISTS idx_memory_items_embedding_hnsw
ON public.memory_items
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- ===========================================================================
-- 4. Fix memory_items semantic search RPC
-- ===========================================================================

-- Drop old signature first to avoid ambiguity
DROP FUNCTION IF EXISTS public.semantic_memory_search(vector(1536), int, uuid, uuid, text, text, text[], text, int, boolean);

CREATE OR REPLACE FUNCTION public.semantic_memory_search(
    p_query_embedding vector(768),
    p_top_k int DEFAULT 10,
    p_tenant_id uuid DEFAULT NULL,
    p_user_id uuid DEFAULT NULL,
    p_role text DEFAULT NULL,
    p_category_key text DEFAULT NULL,
    p_category_keys text[] DEFAULT NULL,
    p_source text DEFAULT NULL,
    p_min_importance int DEFAULT 0,
    p_active_only boolean DEFAULT true
)
RETURNS TABLE (
    id uuid,
    category_key text,
    content text,
    content_json jsonb,
    importance int,
    source text,
    embedding_similarity float8,
    created_at timestamptz,
    updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT
        mi.id,
        mi.category_key,
        mi.content,
        mi.content_json,
        mi.importance,
        mi.source,
        1 - (mi.embedding <=> p_query_embedding) AS embedding_similarity,
        mi.created_at,
        mi.updated_at
    FROM memory_items mi
    WHERE mi.embedding IS NOT NULL
      AND (p_tenant_id IS NULL OR mi.tenant_id = p_tenant_id)
      AND (p_user_id IS NULL OR mi.user_id = p_user_id)
      AND (p_role IS NULL OR mi.role = p_role)
      AND (p_category_key IS NULL OR mi.category_key = p_category_key)
      AND (p_category_keys IS NULL OR mi.category_key = ANY(p_category_keys))
      AND (p_source IS NULL OR mi.source = p_source)
      AND mi.importance >= p_min_importance
      AND (NOT p_active_only OR mi.is_active = true)
    ORDER BY mi.embedding <=> p_query_embedding
    LIMIT p_top_k;
END;
$$;

GRANT EXECUTE ON FUNCTION public.semantic_memory_search(
    vector(768), int, uuid, uuid, text, text, text[], text, int, boolean
) TO authenticated;

GRANT EXECUTE ON FUNCTION public.semantic_memory_search(
    vector(768), int, uuid, uuid, text, text, text[], text, int, boolean
) TO service_role;

-- ===========================================================================
-- 5. Fix memory_upsert_with_embedding if it exists
-- ===========================================================================

-- Drop old signature
DROP FUNCTION IF EXISTS public.memory_upsert_with_embedding(uuid, uuid, text, text, text, jsonb, int, text, vector(1536), text);

-- ===========================================================================
-- 6. Comments
-- ===========================================================================

COMMENT ON FUNCTION public.memory_facts_semantic_search IS
  'VTID-01225: Tenant-safe semantic similarity search on memory_facts (768-dim, text-embedding-004).';

COMMENT ON FUNCTION public.semantic_memory_search IS
  'VTID-01184/01225: Semantic similarity search on memory_items (768-dim, text-embedding-004).';
