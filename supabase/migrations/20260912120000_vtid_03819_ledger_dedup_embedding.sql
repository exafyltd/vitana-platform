-- Migration: 20260912120000_vtid_03819_ledger_dedup_embedding.sql
-- Purpose: VTID-03819 - Backlog-aware task intake (embedding dedup for vtid_ledger)
-- Date: 2026-09-12
--
-- Implements:
--   1. embedding column on vtid_ledger (additive only), matching the
--      vector(1536) shape memory_items already uses (VTID-01184) so the
--      same OpenAI/Gemini embedding-service output can be stored directly.
--   2. HNSW index for fast similarity search, same operator/params as
--      memory_items' own index.
--   3. find_similar_vtid_tasks() RPC — given a query embedding, returns the
--      closest non-terminal ledger rows above a similarity floor. Used by
--      the operator task-creation path (createOperatorTask) to avoid
--      silently creating a near-duplicate task.
--
-- Dependencies:
--   - VTID-01184 (pgvector extension already enabled by that migration)
--
-- GOVERNANCE:
--   - Additive-only changes (new nullable column, new function)
--   - No backfill of the 1,682 existing ledger rows here — deliberate,
--     same reasoning as VTID-03818's title-backfill decision: there is no
--     reliable, cheap way to embed 1,682 historic rows in a SQL migration
--     (embedding generation is an application-level HTTP call, not a SQL
--     operation), and guessing/skipping it silently would be worse than
--     documenting the gap. Rows get an embedding going forward, from the
--     moment this ships, via the application code in the same VTID.
--   - SECURITY INVOKER for the RPC function, consistent with
--     memory_semantic_search.

-- ===========================================================================
-- 1. Add embedding column to vtid_ledger (Additive)
-- ===========================================================================

ALTER TABLE public.vtid_ledger
ADD COLUMN IF NOT EXISTS embedding vector(1536) NULL;

ALTER TABLE public.vtid_ledger
ADD COLUMN IF NOT EXISTS embedding_updated_at timestamptz NULL;

-- ===========================================================================
-- 2. HNSW index for fast similarity search
-- ===========================================================================

CREATE INDEX IF NOT EXISTS idx_vtid_ledger_embedding_hnsw
ON public.vtid_ledger
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- ===========================================================================
-- 3. find_similar_vtid_tasks() RPC
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.find_similar_vtid_tasks(
    p_query_embedding vector(1536),
    p_top_k int DEFAULT 5,
    p_min_similarity float8 DEFAULT 0.80
)
RETURNS TABLE (
    vtid text,
    title text,
    status text,
    similarity float8
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT
        vl.vtid,
        vl.title,
        vl.status,
        (1 - (vl.embedding <=> p_query_embedding))::float8 AS similarity
    FROM public.vtid_ledger vl
    WHERE vl.embedding IS NOT NULL
      AND vl.is_terminal IS DISTINCT FROM true
      AND (1 - (vl.embedding <=> p_query_embedding)) >= p_min_similarity
    ORDER BY vl.embedding <=> p_query_embedding
    LIMIT p_top_k;
END;
$$;

GRANT EXECUTE ON FUNCTION public.find_similar_vtid_tasks(vector(1536), int, float8)
TO service_role;

COMMENT ON FUNCTION public.find_similar_vtid_tasks IS
'VTID-03819: cosine-similarity search over vtid_ledger.embedding, restricted '
'to non-terminal rows, for pre-create duplicate/related-task detection. '
'Returns rows at or above p_min_similarity, closest first.';
