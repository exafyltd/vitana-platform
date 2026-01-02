-- Migration: 20260102000000_vtid_01112_context_assembly_engine.sql
-- Purpose: VTID-01112 Context Assembly Engine (D20 Core Intelligence)
-- Date: 2026-01-02
--
-- Creates the context_assembly_audit table for traceability and governance review.
-- Every context bundle assembled by the engine is logged for:
-- - Explainability (D59)
-- - Debugging
-- - Governance review
--
-- Dependencies:
--   - VTID-01101 (Phase A-Fix) - tenant/user/role helpers
--   - VTID-01104 (Memory Core v1) - memory_items table
--   - VTID-01082 (Memory Garden) - diary and garden tables

-- ===========================================================================
-- A. context_assembly_audit - Audit trail for context bundles
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.context_assembly_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bundle_id TEXT NOT NULL,
    bundle_hash TEXT NOT NULL,
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    active_role TEXT NOT NULL,
    intent TEXT NOT NULL DEFAULT 'general',

    -- Traceability
    memory_ids_used TEXT[] DEFAULT '{}',
    diary_ids_used TEXT[] DEFAULT '{}',
    garden_node_ids_used TEXT[] DEFAULT '{}',
    domain_weights JSONB NOT NULL DEFAULT '{}',

    -- Metrics
    items_considered INT NOT NULL DEFAULT 0,
    items_included INT NOT NULL DEFAULT 0,
    assembly_duration_ms INT NOT NULL DEFAULT 0,

    -- Constraints applied
    constraints_applied JSONB DEFAULT '[]',

    -- Timestamps
    assembled_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_context_audit_tenant_user
    ON public.context_assembly_audit (tenant_id, user_id, assembled_at DESC);

CREATE INDEX IF NOT EXISTS idx_context_audit_bundle_id
    ON public.context_assembly_audit (bundle_id);

CREATE INDEX IF NOT EXISTS idx_context_audit_bundle_hash
    ON public.context_assembly_audit (bundle_hash);

CREATE INDEX IF NOT EXISTS idx_context_audit_intent
    ON public.context_assembly_audit (tenant_id, intent, assembled_at DESC);

-- ===========================================================================
-- B. RLS Policies
-- ===========================================================================

ALTER TABLE public.context_assembly_audit ENABLE ROW LEVEL SECURITY;

-- Allow users to see their own audit entries
DROP POLICY IF EXISTS context_audit_select ON public.context_assembly_audit;
CREATE POLICY context_audit_select ON public.context_assembly_audit
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- Insert allowed only via service role (from gateway)
DROP POLICY IF EXISTS context_audit_insert ON public.context_assembly_audit;
CREATE POLICY context_audit_insert ON public.context_assembly_audit
    FOR INSERT
    TO service_role
    WITH CHECK (true);

-- ===========================================================================
-- C. RPC: context_assembly_log
-- Write an audit entry for a context bundle
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.context_assembly_log(
    p_bundle_id TEXT,
    p_bundle_hash TEXT,
    p_tenant_id UUID,
    p_user_id UUID,
    p_active_role TEXT,
    p_intent TEXT,
    p_memory_ids TEXT[],
    p_diary_ids TEXT[],
    p_garden_node_ids TEXT[],
    p_domain_weights JSONB,
    p_items_considered INT,
    p_items_included INT,
    p_assembly_duration_ms INT,
    p_constraints JSONB,
    p_assembled_at TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_new_id UUID;
BEGIN
    INSERT INTO public.context_assembly_audit (
        bundle_id,
        bundle_hash,
        tenant_id,
        user_id,
        active_role,
        intent,
        memory_ids_used,
        diary_ids_used,
        garden_node_ids_used,
        domain_weights,
        items_considered,
        items_included,
        assembly_duration_ms,
        constraints_applied,
        assembled_at
    ) VALUES (
        p_bundle_id,
        p_bundle_hash,
        p_tenant_id,
        p_user_id,
        p_active_role,
        p_intent,
        COALESCE(p_memory_ids, '{}'),
        COALESCE(p_diary_ids, '{}'),
        COALESCE(p_garden_node_ids, '{}'),
        COALESCE(p_domain_weights, '{}'),
        p_items_considered,
        p_items_included,
        p_assembly_duration_ms,
        COALESCE(p_constraints, '[]'),
        p_assembled_at
    )
    RETURNING id INTO v_new_id;

    RETURN jsonb_build_object(
        'ok', true,
        'id', v_new_id,
        'bundle_id', p_bundle_id
    );
END;
$$;

-- ===========================================================================
-- D. RPC: context_assembly_get_history
-- Get audit history for a user
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.context_assembly_get_history(
    p_limit INT DEFAULT 20,
    p_offset INT DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_entries JSONB;
BEGIN
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
    END IF;

    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', a.id,
                'bundle_id', a.bundle_id,
                'bundle_hash', a.bundle_hash,
                'intent', a.intent,
                'items_included', a.items_included,
                'assembly_duration_ms', a.assembly_duration_ms,
                'assembled_at', a.assembled_at
            )
            ORDER BY a.assembled_at DESC
        ),
        '[]'::JSONB
    )
    INTO v_entries
    FROM public.context_assembly_audit a
    WHERE a.tenant_id = v_tenant_id
      AND a.user_id = v_user_id
    LIMIT p_limit
    OFFSET p_offset;

    RETURN jsonb_build_object(
        'ok', true,
        'entries', v_entries,
        'count', jsonb_array_length(v_entries)
    );
END;
$$;

-- ===========================================================================
-- E. RPC: context_assembly_get_bundle_details
-- Get full details of a specific bundle by ID
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.context_assembly_get_bundle_details(
    p_bundle_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_entry RECORD;
BEGIN
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
    END IF;

    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    SELECT * INTO v_entry
    FROM public.context_assembly_audit
    WHERE bundle_id = p_bundle_id
      AND tenant_id = v_tenant_id
      AND user_id = v_user_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'BUNDLE_NOT_FOUND');
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'bundle_id', v_entry.bundle_id,
        'bundle_hash', v_entry.bundle_hash,
        'intent', v_entry.intent,
        'memory_ids_used', v_entry.memory_ids_used,
        'diary_ids_used', v_entry.diary_ids_used,
        'garden_node_ids_used', v_entry.garden_node_ids_used,
        'domain_weights', v_entry.domain_weights,
        'items_considered', v_entry.items_considered,
        'items_included', v_entry.items_included,
        'assembly_duration_ms', v_entry.assembly_duration_ms,
        'constraints_applied', v_entry.constraints_applied,
        'assembled_at', v_entry.assembled_at,
        'created_at', v_entry.created_at
    );
END;
$$;

-- ===========================================================================
-- Permissions
-- ===========================================================================

GRANT SELECT ON public.context_assembly_audit TO authenticated;
GRANT INSERT ON public.context_assembly_audit TO service_role;

GRANT EXECUTE ON FUNCTION public.context_assembly_log(TEXT, TEXT, UUID, UUID, TEXT, TEXT, TEXT[], TEXT[], TEXT[], JSONB, INT, INT, INT, JSONB, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_assembly_get_history(INT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.context_assembly_get_bundle_details(TEXT) TO authenticated;

-- ===========================================================================
-- Comments
-- ===========================================================================

COMMENT ON TABLE public.context_assembly_audit IS 'VTID-01112: Audit trail for context bundles assembled by the Context Assembly Engine';
COMMENT ON FUNCTION public.context_assembly_log IS 'VTID-01112: Log a context bundle for audit and traceability';
COMMENT ON FUNCTION public.context_assembly_get_history IS 'VTID-01112: Get context assembly history for the current user';
COMMENT ON FUNCTION public.context_assembly_get_bundle_details IS 'VTID-01112: Get full details of a specific context bundle';
