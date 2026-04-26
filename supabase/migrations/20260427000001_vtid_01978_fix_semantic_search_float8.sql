-- VTID-01978: fix memory_semantic_search RPC type mismatch
--
-- The original RPC (VTID-01184, 2026-01-17) declared recency_score and
-- combined_score as float8 in RETURNS TABLE, but the body computed them
-- with `numeric` arithmetic (CASE returning 1.0, EXP() coerced via
-- numeric EPOCH, scalar * float8 → numeric). Postgres rejected every
-- call with:
--
--   42804: structure of query does not match function result type
--   "Returned type numeric does not match expected type
--    double precision in column 16."
--
-- Result: every memory semantic search has been failing since the RPC
-- shipped. The 2748 backfilled embeddings (VTID-01972) are queryable at
-- the column level (vector(1536) — confirmed) but unreachable through
-- the RPC. This migration recreates the function with explicit ::float8
-- casts on the recency calc, the constant 1.0 fallback, and the
-- combined_score scalar coefficients.
--
-- No data change. Only the function body. Signature unchanged.

CREATE OR REPLACE FUNCTION public.memory_semantic_search(
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
    v_tenant_id := COALESCE(p_tenant_id, public.current_tenant_id());
    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'TENANT_REQUIRED: tenant_id must be provided or derivable from context';
    END IF;

    v_user_id := COALESCE(p_user_id, auth.uid());
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'USER_REQUIRED: user_id must be provided or derivable from auth context';
    END IF;

    IF p_max_age_hours IS NOT NULL AND p_max_age_hours > 0 THEN
        v_cutoff_time := NOW() - (p_max_age_hours || ' hours')::interval;
    END IF;

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
            (1 - (mi.embedding <=> p_query_embedding))::float8 AS similarity
        FROM public.memory_items mi
        WHERE
            mi.tenant_id = v_tenant_id
            AND mi.user_id = v_user_id
            AND mi.embedding IS NOT NULL
            AND (p_workspace_scope IS NULL OR mi.workspace_scope = p_workspace_scope OR mi.workspace_scope IS NULL)
            AND (p_active_role IS NULL OR mi.active_role = p_active_role OR mi.active_role IS NULL)
            AND (p_categories IS NULL OR mi.category_key = ANY(p_categories))
            AND (mi.visibility_scope IS NULL OR mi.visibility_scope = p_visibility_scope OR p_visibility_scope = 'public')
            AND (v_cutoff_time IS NULL OR mi.occurred_at >= v_cutoff_time)
    ),
    scored_items AS (
        SELECT
            fi.*,
            CASE
                WHEN p_recency_boost THEN
                    EXP(-EXTRACT(EPOCH FROM (NOW() - fi.occurred_at))::float8 / (7.0 * 24.0 * 3600.0)::float8)::float8
                ELSE 1.0::float8
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
        si.similarity::float8 AS similarity_score,
        si.recency::float8 AS recency_score,
        (0.7::float8 * si.similarity::float8 + 0.3::float8 * si.recency::float8)::float8 AS combined_score
    FROM scored_items si
    ORDER BY combined_score DESC
    LIMIT p_top_k;
END;
$$;

COMMENT ON FUNCTION public.memory_semantic_search IS
'VTID-01184 + VTID-01978: hard-filtered semantic search over memory_items with optional recency boost. Float8-cast for type-safe RETURNS TABLE.';
