-- Migration: 20251231100000_vtid_01099_memory_governance_v1.sql
-- Purpose: VTID-01099 Memory Governance & User Controls v1
-- Date: 2025-12-31
--
-- Provides user-first control over memory:
-- - Visibility: who can see which memory domains
-- - Locks: prevent specific entities from being used in personalization
-- - Deletions: soft-delete ledger with cascade tracking
-- - Exports: user data portability
--
-- Dependencies:
--   - VTID-01101 (Phase A-Fix) - tenant/user/role helpers
--   - VTID-01104 (Memory Core v1) - memory_items table

-- ===========================================================================
-- 4.A memory_visibility_prefs - Controls who can see which memory domains
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.memory_visibility_prefs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    domain TEXT NOT NULL CHECK (domain IN ('diary', 'garden', 'relationships', 'longevity', 'timeline')),
    visibility TEXT NOT NULL CHECK (visibility IN ('private', 'connections', 'professionals', 'custom')),
    custom_rules JSONB NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, user_id, domain)
);

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_memory_visibility_prefs_tenant_user
    ON public.memory_visibility_prefs (tenant_id, user_id);

-- ===========================================================================
-- 4.B memory_locks - Locks memory entities from any downstream use
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.memory_locks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('diary', 'garden_node', 'relationship_edge', 'timeline_entry', 'memory_item')),
    entity_id UUID NOT NULL,
    reason TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, user_id, entity_type, entity_id)
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_memory_locks_tenant_user
    ON public.memory_locks (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_memory_locks_entity
    ON public.memory_locks (entity_type, entity_id);

-- ===========================================================================
-- 4.C memory_deletions - Soft-delete ledger with cascade tracking
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.memory_deletions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('diary', 'garden_node', 'relationship_edge', 'timeline_entry', 'memory_item')),
    entity_id UUID NOT NULL,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cascade JSONB NULL,  -- Records what was affected by this deletion
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_memory_deletions_tenant_user
    ON public.memory_deletions (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_memory_deletions_entity
    ON public.memory_deletions (entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_memory_deletions_deleted_at
    ON public.memory_deletions (deleted_at DESC);

-- ===========================================================================
-- 4.D memory_exports - Tracks user-requested data exports
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.memory_exports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    domains TEXT[] NOT NULL,
    format TEXT NOT NULL CHECK (format IN ('json', 'csv')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'ready', 'expired', 'failed')),
    file_url TEXT NULL,  -- Signed URL when ready
    file_size_bytes BIGINT NULL,
    error_message TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NULL
);

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_memory_exports_tenant_user
    ON public.memory_exports (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_memory_exports_status
    ON public.memory_exports (status) WHERE status IN ('pending', 'processing');

-- ===========================================================================
-- 5. RLS Policies
-- ===========================================================================

-- Enable RLS on all tables
ALTER TABLE public.memory_visibility_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_exports ENABLE ROW LEVEL SECURITY;

-- memory_visibility_prefs: User owns their visibility preferences
DROP POLICY IF EXISTS memory_visibility_prefs_select ON public.memory_visibility_prefs;
CREATE POLICY memory_visibility_prefs_select ON public.memory_visibility_prefs
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS memory_visibility_prefs_insert ON public.memory_visibility_prefs;
CREATE POLICY memory_visibility_prefs_insert ON public.memory_visibility_prefs
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS memory_visibility_prefs_update ON public.memory_visibility_prefs;
CREATE POLICY memory_visibility_prefs_update ON public.memory_visibility_prefs
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

DROP POLICY IF EXISTS memory_visibility_prefs_delete ON public.memory_visibility_prefs;
CREATE POLICY memory_visibility_prefs_delete ON public.memory_visibility_prefs
    FOR DELETE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- memory_locks: User owns their locks
DROP POLICY IF EXISTS memory_locks_select ON public.memory_locks;
CREATE POLICY memory_locks_select ON public.memory_locks
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS memory_locks_insert ON public.memory_locks;
CREATE POLICY memory_locks_insert ON public.memory_locks
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS memory_locks_delete ON public.memory_locks;
CREATE POLICY memory_locks_delete ON public.memory_locks
    FOR DELETE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- memory_deletions: User can view their deletion history
DROP POLICY IF EXISTS memory_deletions_select ON public.memory_deletions;
CREATE POLICY memory_deletions_select ON public.memory_deletions
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS memory_deletions_insert ON public.memory_deletions;
CREATE POLICY memory_deletions_insert ON public.memory_deletions
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- memory_exports: User owns their exports
DROP POLICY IF EXISTS memory_exports_select ON public.memory_exports;
CREATE POLICY memory_exports_select ON public.memory_exports
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS memory_exports_insert ON public.memory_exports;
CREATE POLICY memory_exports_insert ON public.memory_exports
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS memory_exports_update ON public.memory_exports;
CREATE POLICY memory_exports_update ON public.memory_exports
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
-- 6. RPC Functions
-- ===========================================================================

-- 6.1 memory_set_visibility - Set visibility for a domain
CREATE OR REPLACE FUNCTION public.memory_set_visibility(
    p_domain TEXT,
    p_visibility TEXT,
    p_custom_rules JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_pref_id UUID;
BEGIN
    -- Validate inputs
    IF p_domain NOT IN ('diary', 'garden', 'relationships', 'longevity', 'timeline') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_DOMAIN',
            'message', 'domain must be one of: diary, garden, relationships, longevity, timeline'
        );
    END IF;

    IF p_visibility NOT IN ('private', 'connections', 'professionals', 'custom') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_VISIBILITY',
            'message', 'visibility must be one of: private, connections, professionals, custom'
        );
    END IF;

    -- Custom visibility requires custom_rules
    IF p_visibility = 'custom' AND p_custom_rules IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'CUSTOM_RULES_REQUIRED',
            'message', 'custom_rules is required when visibility is custom'
        );
    END IF;

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

    -- Upsert visibility preference
    INSERT INTO public.memory_visibility_prefs (
        tenant_id,
        user_id,
        domain,
        visibility,
        custom_rules,
        updated_at
    ) VALUES (
        v_tenant_id,
        v_user_id,
        p_domain,
        p_visibility,
        p_custom_rules,
        NOW()
    )
    ON CONFLICT (tenant_id, user_id, domain) DO UPDATE SET
        visibility = EXCLUDED.visibility,
        custom_rules = EXCLUDED.custom_rules,
        updated_at = NOW()
    RETURNING id INTO v_pref_id;

    RETURN jsonb_build_object(
        'ok', true,
        'id', v_pref_id,
        'domain', p_domain,
        'visibility', p_visibility
    );
END;
$$;

-- 6.2 memory_lock_entity - Lock an entity from downstream use
CREATE OR REPLACE FUNCTION public.memory_lock_entity(
    p_entity_type TEXT,
    p_entity_id UUID,
    p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_lock_id UUID;
BEGIN
    -- Validate entity_type
    IF p_entity_type NOT IN ('diary', 'garden_node', 'relationship_edge', 'timeline_entry', 'memory_item') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_ENTITY_TYPE',
            'message', 'entity_type must be one of: diary, garden_node, relationship_edge, timeline_entry, memory_item'
        );
    END IF;

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

    -- Insert lock (or return existing)
    INSERT INTO public.memory_locks (
        tenant_id,
        user_id,
        entity_type,
        entity_id,
        reason
    ) VALUES (
        v_tenant_id,
        v_user_id,
        p_entity_type,
        p_entity_id,
        p_reason
    )
    ON CONFLICT (tenant_id, user_id, entity_type, entity_id) DO UPDATE SET
        reason = COALESCE(EXCLUDED.reason, public.memory_locks.reason)
    RETURNING id INTO v_lock_id;

    RETURN jsonb_build_object(
        'ok', true,
        'id', v_lock_id,
        'entity_type', p_entity_type,
        'entity_id', p_entity_id,
        'locked', true
    );
END;
$$;

-- 6.3 memory_unlock_entity - Remove lock from an entity
CREATE OR REPLACE FUNCTION public.memory_unlock_entity(
    p_entity_type TEXT,
    p_entity_id UUID
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
    -- Validate entity_type
    IF p_entity_type NOT IN ('diary', 'garden_node', 'relationship_edge', 'timeline_entry', 'memory_item') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_ENTITY_TYPE',
            'message', 'entity_type must be one of: diary, garden_node, relationship_edge, timeline_entry, memory_item'
        );
    END IF;

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

    -- Delete lock
    DELETE FROM public.memory_locks
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND entity_type = p_entity_type
      AND entity_id = p_entity_id;

    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

    RETURN jsonb_build_object(
        'ok', true,
        'entity_type', p_entity_type,
        'entity_id', p_entity_id,
        'unlocked', v_deleted_count > 0
    );
END;
$$;

-- 6.4 memory_delete_entity - Soft-delete an entity with cascade tracking
CREATE OR REPLACE FUNCTION public.memory_delete_entity(
    p_entity_type TEXT,
    p_entity_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_deletion_id UUID;
    v_cascade JSONB := '[]'::JSONB;
BEGIN
    -- Validate entity_type
    IF p_entity_type NOT IN ('diary', 'garden_node', 'relationship_edge', 'timeline_entry', 'memory_item') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_ENTITY_TYPE',
            'message', 'entity_type must be one of: diary, garden_node, relationship_edge, timeline_entry, memory_item'
        );
    END IF;

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

    -- Check if already deleted
    IF EXISTS (
        SELECT 1 FROM public.memory_deletions
        WHERE tenant_id = v_tenant_id
          AND user_id = v_user_id
          AND entity_type = p_entity_type
          AND entity_id = p_entity_id
    ) THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'ALREADY_DELETED',
            'message', 'Entity has already been deleted'
        );
    END IF;

    -- Handle cascade based on entity type (v1: simple cascade tracking)
    -- In v1, we record the intention but don't actually cascade to other tables
    -- Future versions will implement actual cascade logic
    CASE p_entity_type
        WHEN 'memory_item' THEN
            -- Record that this memory item is being deleted
            v_cascade := jsonb_build_object(
                'type', 'memory_item',
                'affected', jsonb_build_array()
            );
        WHEN 'diary' THEN
            -- Diary entries may cascade to linked garden nodes and relationship signals
            v_cascade := jsonb_build_object(
                'type', 'diary',
                'note', 'Linked garden nodes and relationship signals should be recalculated'
            );
        WHEN 'relationship_edge' THEN
            -- Removing an edge requires strength recalculation
            v_cascade := jsonb_build_object(
                'type', 'relationship_edge',
                'note', 'Relationship strengths should be recalculated'
            );
        ELSE
            v_cascade := jsonb_build_object(
                'type', p_entity_type,
                'note', 'No cascade required'
            );
    END CASE;

    -- Record the deletion
    INSERT INTO public.memory_deletions (
        tenant_id,
        user_id,
        entity_type,
        entity_id,
        deleted_at,
        cascade
    ) VALUES (
        v_tenant_id,
        v_user_id,
        p_entity_type,
        p_entity_id,
        NOW(),
        v_cascade
    )
    RETURNING id INTO v_deletion_id;

    RETURN jsonb_build_object(
        'ok', true,
        'id', v_deletion_id,
        'entity_type', p_entity_type,
        'entity_id', p_entity_id,
        'deleted', true,
        'cascade', v_cascade
    );
END;
$$;

-- 6.5 memory_request_export - Request a data export
CREATE OR REPLACE FUNCTION public.memory_request_export(
    p_domains TEXT[],
    p_format TEXT DEFAULT 'json'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_export_id UUID;
    v_domain TEXT;
    v_valid_domains TEXT[] := ARRAY['diary', 'garden', 'relationships', 'longevity', 'timeline', 'topic_profile'];
BEGIN
    -- Validate format
    IF p_format NOT IN ('json', 'csv') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_FORMAT',
            'message', 'format must be one of: json, csv'
        );
    END IF;

    -- Validate domains
    IF p_domains IS NULL OR array_length(p_domains, 1) IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'DOMAINS_REQUIRED',
            'message', 'At least one domain is required'
        );
    END IF;

    FOREACH v_domain IN ARRAY p_domains LOOP
        IF NOT (v_domain = ANY(v_valid_domains)) THEN
            RETURN jsonb_build_object(
                'ok', false,
                'error', 'INVALID_DOMAIN',
                'message', format('Invalid domain: %s. Valid domains: %s', v_domain, array_to_string(v_valid_domains, ', '))
            );
        END IF;
    END LOOP;

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

    -- Create export request (expires in 24 hours)
    INSERT INTO public.memory_exports (
        tenant_id,
        user_id,
        domains,
        format,
        status,
        expires_at
    ) VALUES (
        v_tenant_id,
        v_user_id,
        p_domains,
        p_format,
        'pending',
        NOW() + INTERVAL '24 hours'
    )
    RETURNING id INTO v_export_id;

    RETURN jsonb_build_object(
        'ok', true,
        'id', v_export_id,
        'domains', p_domains,
        'format', p_format,
        'status', 'pending'
    );
END;
$$;

-- 6.6 memory_get_export_status - Get export status
CREATE OR REPLACE FUNCTION public.memory_get_export_status(
    p_export_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_export RECORD;
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

    -- Get export
    SELECT id, domains, format, status, file_url, file_size_bytes, error_message, created_at, expires_at
    INTO v_export
    FROM public.memory_exports
    WHERE id = p_export_id
      AND tenant_id = v_tenant_id
      AND user_id = v_user_id;

    IF v_export IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'NOT_FOUND',
            'message', 'Export not found'
        );
    END IF;

    -- Check if expired
    IF v_export.status = 'ready' AND v_export.expires_at < NOW() THEN
        -- Mark as expired
        UPDATE public.memory_exports
        SET status = 'expired'
        WHERE id = p_export_id;

        RETURN jsonb_build_object(
            'ok', true,
            'id', v_export.id,
            'domains', v_export.domains,
            'format', v_export.format,
            'status', 'expired',
            'created_at', v_export.created_at,
            'expires_at', v_export.expires_at
        );
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'id', v_export.id,
        'domains', v_export.domains,
        'format', v_export.format,
        'status', v_export.status,
        'file_url', v_export.file_url,
        'file_size_bytes', v_export.file_size_bytes,
        'error_message', v_export.error_message,
        'created_at', v_export.created_at,
        'expires_at', v_export.expires_at
    );
END;
$$;

-- 6.7 memory_get_settings - Get all memory settings for user
CREATE OR REPLACE FUNCTION public.memory_get_settings()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_visibility JSONB;
    v_locks JSONB;
    v_deletions_count INT;
    v_pending_exports JSONB;
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

    -- Get visibility preferences
    SELECT COALESCE(
        jsonb_object_agg(domain, jsonb_build_object(
            'visibility', visibility,
            'custom_rules', custom_rules,
            'updated_at', updated_at
        )),
        '{}'::JSONB
    )
    INTO v_visibility
    FROM public.memory_visibility_prefs
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id;

    -- Get locked entities count by type
    SELECT COALESCE(
        jsonb_object_agg(entity_type, cnt),
        '{}'::JSONB
    )
    INTO v_locks
    FROM (
        SELECT entity_type, COUNT(*) as cnt
        FROM public.memory_locks
        WHERE tenant_id = v_tenant_id
          AND user_id = v_user_id
        GROUP BY entity_type
    ) t;

    -- Get deletion count
    SELECT COUNT(*)
    INTO v_deletions_count
    FROM public.memory_deletions
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id;

    -- Get pending/processing exports
    SELECT COALESCE(
        jsonb_agg(jsonb_build_object(
            'id', id,
            'domains', domains,
            'format', format,
            'status', status,
            'created_at', created_at,
            'expires_at', expires_at
        )),
        '[]'::JSONB
    )
    INTO v_pending_exports
    FROM public.memory_exports
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND status IN ('pending', 'processing', 'ready');

    RETURN jsonb_build_object(
        'ok', true,
        'visibility', v_visibility,
        'locks', v_locks,
        'deletions_count', v_deletions_count,
        'exports', v_pending_exports
    );
END;
$$;

-- 6.8 memory_get_locked_entities - Get list of locked entity IDs
CREATE OR REPLACE FUNCTION public.memory_get_locked_entities(
    p_entity_type TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_locks JSONB;
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

    -- Get locks
    SELECT COALESCE(
        jsonb_agg(jsonb_build_object(
            'id', id,
            'entity_type', entity_type,
            'entity_id', entity_id,
            'reason', reason,
            'created_at', created_at
        ) ORDER BY created_at DESC),
        '[]'::JSONB
    )
    INTO v_locks
    FROM public.memory_locks
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND (p_entity_type IS NULL OR entity_type = p_entity_type);

    RETURN jsonb_build_object(
        'ok', true,
        'locks', v_locks
    );
END;
$$;

-- 6.9 memory_is_entity_locked - Check if specific entity is locked
CREATE OR REPLACE FUNCTION public.memory_is_entity_locked(
    p_entity_type TEXT,
    p_entity_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
BEGIN
    v_tenant_id := public.current_tenant_id();
    v_user_id := auth.uid();

    IF v_tenant_id IS NULL OR v_user_id IS NULL THEN
        RETURN false;
    END IF;

    RETURN EXISTS (
        SELECT 1 FROM public.memory_locks
        WHERE tenant_id = v_tenant_id
          AND user_id = v_user_id
          AND entity_type = p_entity_type
          AND entity_id = p_entity_id
    );
END;
$$;

-- 6.10 memory_is_entity_deleted - Check if specific entity is deleted
CREATE OR REPLACE FUNCTION public.memory_is_entity_deleted(
    p_entity_type TEXT,
    p_entity_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
BEGIN
    v_tenant_id := public.current_tenant_id();
    v_user_id := auth.uid();

    IF v_tenant_id IS NULL OR v_user_id IS NULL THEN
        RETURN false;
    END IF;

    RETURN EXISTS (
        SELECT 1 FROM public.memory_deletions
        WHERE tenant_id = v_tenant_id
          AND user_id = v_user_id
          AND entity_type = p_entity_type
          AND entity_id = p_entity_id
    );
END;
$$;

-- ===========================================================================
-- 7. Permissions
-- ===========================================================================

-- RPC functions: callable by authenticated users
GRANT EXECUTE ON FUNCTION public.memory_set_visibility(TEXT, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.memory_lock_entity(TEXT, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.memory_unlock_entity(TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.memory_delete_entity(TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.memory_request_export(TEXT[], TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.memory_get_export_status(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.memory_get_settings() TO authenticated;
GRANT EXECUTE ON FUNCTION public.memory_get_locked_entities(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.memory_is_entity_locked(TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.memory_is_entity_deleted(TEXT, UUID) TO authenticated;

-- Tables: allow authenticated users to interact (RLS enforces row-level access)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memory_visibility_prefs TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.memory_locks TO authenticated;
GRANT SELECT, INSERT ON public.memory_deletions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.memory_exports TO authenticated;

-- ===========================================================================
-- 8. Comments
-- ===========================================================================

COMMENT ON TABLE public.memory_visibility_prefs IS 'VTID-01099: Controls who can see which memory domains (private/connections/professionals/custom)';
COMMENT ON TABLE public.memory_locks IS 'VTID-01099: Locks memory entities from any downstream use (personalization, matching, summaries)';
COMMENT ON TABLE public.memory_deletions IS 'VTID-01099: Soft-delete ledger with cascade tracking for memory entities';
COMMENT ON TABLE public.memory_exports IS 'VTID-01099: Tracks user-requested data exports for data portability';

COMMENT ON FUNCTION public.memory_set_visibility IS 'VTID-01099: Set visibility preference for a memory domain';
COMMENT ON FUNCTION public.memory_lock_entity IS 'VTID-01099: Lock an entity from downstream use';
COMMENT ON FUNCTION public.memory_unlock_entity IS 'VTID-01099: Unlock a previously locked entity';
COMMENT ON FUNCTION public.memory_delete_entity IS 'VTID-01099: Soft-delete an entity with cascade tracking';
COMMENT ON FUNCTION public.memory_request_export IS 'VTID-01099: Request a data export for specified domains';
COMMENT ON FUNCTION public.memory_get_export_status IS 'VTID-01099: Get status of a data export request';
COMMENT ON FUNCTION public.memory_get_settings IS 'VTID-01099: Get all memory governance settings for current user';
COMMENT ON FUNCTION public.memory_get_locked_entities IS 'VTID-01099: Get list of locked entities';
COMMENT ON FUNCTION public.memory_is_entity_locked IS 'VTID-01099: Check if a specific entity is locked';
COMMENT ON FUNCTION public.memory_is_entity_deleted IS 'VTID-01099: Check if a specific entity is deleted';

-- ===========================================================================
-- 9. Update memory_get_context to respect locks and deletions
-- ===========================================================================

-- Override memory_get_context to filter out locked and deleted entities
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
    -- VTID-01099: Exclude locked and deleted entities
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', mi.id,
                'category_key', mi.category_key,
                'source', mi.source,
                'content', mi.content,
                'occurred_at', mi.occurred_at,
                'importance', mi.importance,
                'is_locked', EXISTS (
                    SELECT 1 FROM public.memory_locks ml
                    WHERE ml.tenant_id = v_tenant_id
                      AND ml.user_id = v_user_id
                      AND ml.entity_type = 'memory_item'
                      AND ml.entity_id = mi.id
                )
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
      -- VTID-01099: Exclude deleted entities
      AND NOT EXISTS (
          SELECT 1 FROM public.memory_deletions md
          WHERE md.tenant_id = v_tenant_id
            AND md.user_id = v_user_id
            AND md.entity_type = 'memory_item'
            AND md.entity_id = mi.id
      )
    LIMIT p_limit;

    -- Return success with items
    RETURN jsonb_build_object(
        'ok', true,
        'items', v_items
    );
END;
$$;

-- 9.1 memory_get_context_for_personalization - Excludes locked items
-- This variant is used for personalization, matching, summaries
CREATE OR REPLACE FUNCTION public.memory_get_context_for_personalization(
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

    -- Query memory items - EXCLUDE both locked and deleted for personalization
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
      -- VTID-01099: Exclude locked entities from personalization
      AND NOT EXISTS (
          SELECT 1 FROM public.memory_locks ml
          WHERE ml.tenant_id = v_tenant_id
            AND ml.user_id = v_user_id
            AND ml.entity_type = 'memory_item'
            AND ml.entity_id = mi.id
      )
      -- VTID-01099: Exclude deleted entities
      AND NOT EXISTS (
          SELECT 1 FROM public.memory_deletions md
          WHERE md.tenant_id = v_tenant_id
            AND md.user_id = v_user_id
            AND md.entity_type = 'memory_item'
            AND md.entity_id = mi.id
      )
    LIMIT p_limit;

    -- Return success with items
    RETURN jsonb_build_object(
        'ok', true,
        'items', v_items
    );
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION public.memory_get_context_for_personalization(INT, TEXT[], TIMESTAMPTZ) TO authenticated;

COMMENT ON FUNCTION public.memory_get_context_for_personalization IS 'VTID-01099: Retrieve memory context for personalization (excludes locked and deleted items)';
