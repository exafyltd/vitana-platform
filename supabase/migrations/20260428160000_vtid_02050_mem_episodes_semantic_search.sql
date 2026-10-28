-- VTID-02050 / Phase 6b — semantic search over mem_episodes.
--
-- mem_episodes is the bi-temporal Tier 2 mirror of memory_items, populated
-- by the dual-writer (Phase 5b, VTID-02005) plus the legacy backfill
-- (Phase 5c, VTID-02007). It carries the same vector(1536) embedding column
-- and HNSW index, so semantic search over it can be cosine-similarity
-- ranked the same way memory_semantic_search ranks memory_items.
--
-- This RPC mirrors memory_semantic_search's contract but reads from
-- mem_episodes and respects the bi-temporal valid_to gate.

CREATE OR REPLACE FUNCTION public.mem_episodes_semantic_search(
    p_query_embedding vector(1536),
    p_top_k int DEFAULT 10,
    p_tenant_id uuid DEFAULT NULL,
    p_user_id uuid DEFAULT NULL,
    p_workspace_scope text DEFAULT NULL,
    p_active_role text DEFAULT NULL,
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
    actor_id text,
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
  v_user_id  uuid;
  v_cutoff   timestamptz;
BEGIN
  v_tenant_id := COALESCE(p_tenant_id, public.current_tenant_id());
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'TENANT_REQUIRED: tenant_id must be provided or derivable from context';
  END IF;

  v_user_id := COALESCE(p_user_id, auth.uid());
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'USER_REQUIRED: user_id must be provided or derivable from auth context';
  END IF;

  IF p_max_age_hours IS NOT NULL AND p_max_age_hours > 0 THEN
    v_cutoff := NOW() - (p_max_age_hours || ' hours')::interval;
  END IF;

  RETURN QUERY
  WITH filtered AS (
    SELECT
      me.id,
      me.content,
      me.content_json,
      me.category_key,
      me.source,
      me.importance,
      me.occurred_at,
      me.created_at,
      me.active_role,
      me.workspace_scope,
      me.visibility_scope,
      me.vtid,
      me.origin_service,
      me.conversation_id,
      me.actor_id,
      me.embedding,
      (1 - (me.embedding <=> p_query_embedding))::float8 AS similarity
    FROM public.mem_episodes me
    WHERE
      me.tenant_id = v_tenant_id
      AND me.user_id = v_user_id
      AND me.embedding IS NOT NULL
      AND me.valid_to IS NULL  -- active rows only (bi-temporal)
      AND (p_workspace_scope IS NULL OR me.workspace_scope = p_workspace_scope OR me.workspace_scope IS NULL)
      AND (p_active_role IS NULL OR me.active_role = p_active_role OR me.active_role IS NULL)
      AND (p_categories IS NULL OR me.category_key = ANY(p_categories))
      AND (me.visibility_scope IS NULL OR me.visibility_scope = p_visibility_scope OR p_visibility_scope = 'public')
      AND (v_cutoff IS NULL OR me.occurred_at >= v_cutoff)
  ),
  scored AS (
    SELECT
      f.*,
      CASE
        WHEN p_recency_boost THEN
          EXP(-EXTRACT(EPOCH FROM (NOW() - f.occurred_at))::float8 / (7.0 * 24.0 * 3600.0)::float8)::float8
        ELSE 1.0::float8
      END AS recency
    FROM filtered f
  )
  SELECT
    s.id,
    s.content,
    s.content_json,
    s.category_key,
    s.source,
    s.importance,
    s.occurred_at,
    s.created_at,
    s.active_role,
    s.workspace_scope,
    s.visibility_scope,
    s.vtid,
    s.origin_service,
    s.conversation_id,
    s.actor_id,
    s.similarity::float8 AS similarity_score,
    s.recency::float8 AS recency_score,
    (0.7::float8 * s.similarity::float8 + 0.3::float8 * s.recency::float8)::float8 AS combined_score
  FROM scored s
  ORDER BY combined_score DESC
  LIMIT p_top_k;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mem_episodes_semantic_search(
  vector(1536), int, uuid, uuid, text, text, text[], text, int, boolean
) TO authenticated, service_role;

COMMENT ON FUNCTION public.mem_episodes_semantic_search IS
  'VTID-02050 Phase 6b — semantic search over mem_episodes (bi-temporal Tier 2 mirror). Same contract as memory_semantic_search but adds actor_id passthrough and respects valid_to NULL.';
