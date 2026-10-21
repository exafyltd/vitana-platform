-- =============================================================================
-- VTID-01225: Add embedding support to memory_facts table
--
-- Adds pgvector embedding column to memory_facts (Option A from architecture review).
-- This keeps the deliberate separation between structured facts (memory_facts)
-- and unstructured items (memory_items) while enabling semantic search on facts.
--
-- Includes:
-- 1. Embedding columns (vector(1536), model, updated_at)
-- 2. HNSW index for cosine similarity search
-- 3. memory_facts_semantic_search() RPC — tenant-safe similarity search
-- 4. memory_facts_needing_embeddings() RPC — for batch embedding pipeline
--
-- Dependencies:
-- - pgvector extension (already enabled by VTID-01184)
-- - memory_facts table (VTID-01192)
-- =============================================================================

-- ===========================================================================
-- 1. Add embedding columns to memory_facts
-- ===========================================================================

ALTER TABLE public.memory_facts
  ADD COLUMN IF NOT EXISTS embedding vector(1536),
  ADD COLUMN IF NOT EXISTS embedding_model TEXT,
  ADD COLUMN IF NOT EXISTS embedding_updated_at TIMESTAMPTZ;

-- ===========================================================================
-- 2. HNSW index for cosine similarity search
-- ===========================================================================

CREATE INDEX IF NOT EXISTS idx_memory_facts_embedding_hnsw
ON public.memory_facts
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Composite index for filtered similarity queries (tenant scoped)
CREATE INDEX IF NOT EXISTS idx_memory_facts_tenant_user_embedding
ON public.memory_facts (tenant_id, user_id)
WHERE embedding IS NOT NULL AND superseded_by IS NULL;

-- Index for finding facts needing embeddings
CREATE INDEX IF NOT EXISTS idx_memory_facts_needs_embedding
ON public.memory_facts (extracted_at)
WHERE embedding IS NULL AND superseded_by IS NULL;

-- ===========================================================================
-- 3. Semantic search RPC for memory_facts
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.memory_facts_semantic_search(
  p_query_embedding vector(1536),
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
  -- Require tenant_id and user_id for isolation
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

-- ===========================================================================
-- 4. Helper: get facts needing embeddings (for batch pipeline)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.memory_facts_needing_embeddings(
  p_batch_size int DEFAULT 100,
  p_tenant_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  fact_key text,
  fact_value text,
  entity text,
  tenant_id uuid,
  user_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    mf.id,
    mf.fact_key,
    mf.fact_value,
    mf.entity,
    mf.tenant_id,
    mf.user_id
  FROM memory_facts mf
  WHERE mf.embedding IS NULL
    AND mf.superseded_by IS NULL
    AND (p_tenant_id IS NULL OR mf.tenant_id = p_tenant_id)
  ORDER BY mf.extracted_at DESC
  LIMIT p_batch_size;
END;
$$;

-- ===========================================================================
-- 5. Permissions
-- ===========================================================================

GRANT EXECUTE ON FUNCTION public.memory_facts_semantic_search(
  vector(1536), int, uuid, uuid, text, numeric
) TO authenticated;

GRANT EXECUTE ON FUNCTION public.memory_facts_needing_embeddings(
  int, uuid
) TO service_role;

-- ===========================================================================
-- 6. Comments
-- ===========================================================================

COMMENT ON FUNCTION public.memory_facts_semantic_search IS
  'VTID-01225: Tenant-safe semantic similarity search on memory_facts. '
  'Requires tenant_id and user_id. Returns top-K facts by cosine similarity. '
  'Only searches non-superseded facts with embeddings.';

COMMENT ON FUNCTION public.memory_facts_needing_embeddings IS
  'VTID-01225: Get memory_facts that need embeddings generated (for batch pipeline). '
  'Returns non-superseded facts without embeddings, ordered by most recent first.';
