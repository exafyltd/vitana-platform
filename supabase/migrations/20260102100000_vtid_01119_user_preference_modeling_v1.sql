-- Migration: 20260102100000_vtid_01119_user_preference_modeling_v1.sql
-- Purpose: VTID-01119 D27 Core Intelligence - User Preference & Constraint Modeling Engine v1
-- Date: 2026-01-02
--
-- Creates a deterministic Preference & Constraint Modeling Engine that captures
-- how the user wants intelligence to behave, not just what they ask.
--
-- Personalization without constraints becomes manipulation.
-- Constraints make intelligence respectful.
--
-- Dependencies:
--   - VTID-01101 (Phase A-Fix) - tenant/user/role helpers
--   - VTID-01099 (Memory Governance) - memory locks and deletions
--   - VTID-01096 (Cross-Domain Personalization) - weakness detection

-- ===========================================================================
-- 1. PREFERENCE CATEGORIES (Canonical)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.preference_categories (
    key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    description TEXT,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert canonical preference categories per spec
INSERT INTO public.preference_categories (key, label, description, sort_order) VALUES
    ('health', 'Health Preferences', 'Diet, intensity, sensitivity, medical constraints', 10),
    ('communication', 'Communication Style', 'Short vs detailed, proactive vs reactive, tone', 20),
    ('social', 'Social Boundaries', 'Introvert/extrovert, contact limits, group size preferences', 30),
    ('economic', 'Economic Behavior', 'Spend/earn sensitivity, price range preferences', 40),
    ('autonomy', 'Autonomy Tolerance', 'Ask vs act, automation level, decision delegation', 50),
    ('privacy', 'Privacy Sensitivity', 'Data sharing, visibility, third-party access', 60)
ON CONFLICT (key) DO NOTHING;

-- ===========================================================================
-- 2. USER EXPLICIT PREFERENCES
-- ===========================================================================
-- Preferences explicitly set by the user - highest confidence, override inference

CREATE TABLE IF NOT EXISTS public.user_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    category TEXT NOT NULL REFERENCES public.preference_categories(key),
    preference_key TEXT NOT NULL,
    preference_value JSONB NOT NULL,
    priority INT NOT NULL DEFAULT 1 CHECK (priority >= 0 AND priority <= 2), -- 0=low, 1=medium, 2=high
    source TEXT NOT NULL DEFAULT 'explicit' CHECK (source IN ('explicit', 'onboarding', 'settings', 'conversation')),
    scope TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'domain', 'context')),
    scope_domain TEXT NULL, -- e.g., 'health', 'community', 'matchmaking'
    confidence INT NOT NULL DEFAULT 100 CHECK (confidence >= 0 AND confidence <= 100),
    last_confirmed_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, user_id, category, preference_key, scope, scope_domain)
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_user_preferences_tenant_user
    ON public.user_preferences (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_user_preferences_category
    ON public.user_preferences (tenant_id, user_id, category);

CREATE INDEX IF NOT EXISTS idx_user_preferences_updated
    ON public.user_preferences (updated_at DESC);

-- ===========================================================================
-- 3. USER INFERRED PREFERENCES
-- ===========================================================================
-- Preferences inferred from user behavior, diary, health signals, etc.
-- Inferred preferences NEVER reach max confidence (capped at 85)

CREATE TABLE IF NOT EXISTS public.user_preference_inferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    category TEXT NOT NULL REFERENCES public.preference_categories(key),
    preference_key TEXT NOT NULL,
    preference_value JSONB NOT NULL,
    confidence INT NOT NULL DEFAULT 50 CHECK (confidence >= 0 AND confidence <= 85), -- Capped at 85 per spec
    evidence JSONB NOT NULL DEFAULT '[]'::JSONB, -- Array of evidence sources
    evidence_count INT NOT NULL DEFAULT 0,
    scope TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'domain', 'context')),
    scope_domain TEXT NULL,
    inferred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_reinforced_at TIMESTAMPTZ NULL,
    computed_date DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, user_id, category, preference_key, scope, scope_domain)
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_user_preference_inferences_tenant_user
    ON public.user_preference_inferences (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_user_preference_inferences_category
    ON public.user_preference_inferences (tenant_id, user_id, category);

CREATE INDEX IF NOT EXISTS idx_user_preference_inferences_confidence
    ON public.user_preference_inferences (tenant_id, user_id, confidence DESC);

CREATE INDEX IF NOT EXISTS idx_user_preference_inferences_computed
    ON public.user_preference_inferences (computed_date DESC);

-- ===========================================================================
-- 4. USER CONSTRAINTS (Hard Boundaries)
-- ===========================================================================
-- Constraints are hard boundaries that ALWAYS override preferences
-- Examples: topics to avoid, domains to down-rank, timing restrictions

CREATE TABLE IF NOT EXISTS public.user_constraints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    constraint_type TEXT NOT NULL CHECK (constraint_type IN (
        'topic_avoid',      -- Topics to never surface
        'domain_downrank',  -- Domains to de-prioritize
        'timing',           -- Time-based restrictions (quiet hours, etc.)
        'role_limit',       -- Role-specific limits
        'contact_limit',    -- Contact frequency limits
        'content_filter',   -- Content type filters
        'safety'            -- Safety-related constraints
    )),
    constraint_key TEXT NOT NULL,
    constraint_value JSONB NOT NULL,
    severity TEXT NOT NULL DEFAULT 'hard' CHECK (severity IN ('hard', 'soft')),
    reason TEXT NULL, -- User-provided reason
    source TEXT NOT NULL DEFAULT 'explicit' CHECK (source IN ('explicit', 'inferred', 'system', 'safety')),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, user_id, constraint_type, constraint_key)
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_user_constraints_tenant_user
    ON public.user_constraints (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_user_constraints_type
    ON public.user_constraints (tenant_id, user_id, constraint_type);

CREATE INDEX IF NOT EXISTS idx_user_constraints_active
    ON public.user_constraints (tenant_id, user_id, active) WHERE active = TRUE;

-- ===========================================================================
-- 5. PREFERENCE BUNDLES (Canonical Snapshot)
-- ===========================================================================
-- Computed preference bundles for downstream intelligence consumption
-- Generated on demand or via scheduled recompute

CREATE TABLE IF NOT EXISTS public.user_preference_bundles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    preferences JSONB NOT NULL DEFAULT '[]'::JSONB,
    constraints JSONB NOT NULL DEFAULT '[]'::JSONB,
    confidence_level INT NOT NULL DEFAULT 0 CHECK (confidence_level >= 0 AND confidence_level <= 100),
    preference_count INT NOT NULL DEFAULT 0,
    constraint_count INT NOT NULL DEFAULT 0,
    last_confirmed_at TIMESTAMPTZ NULL,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NULL, -- Optional TTL for cache invalidation
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, user_id)
);

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_user_preference_bundles_tenant_user
    ON public.user_preference_bundles (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_user_preference_bundles_computed
    ON public.user_preference_bundles (computed_at DESC);

-- ===========================================================================
-- 6. PREFERENCE AUDIT LOG (Traceability)
-- ===========================================================================
-- Audit log for all preference changes per spec section 9

CREATE TABLE IF NOT EXISTS public.user_preference_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    action TEXT NOT NULL CHECK (action IN (
        'preference_created',
        'preference_updated',
        'preference_deleted',
        'preference_confirmed',
        'inference_created',
        'inference_updated',
        'inference_reinforced',
        'inference_downgraded',
        'constraint_created',
        'constraint_updated',
        'constraint_deleted',
        'constraint_deactivated',
        'bundle_computed'
    )),
    target_type TEXT NOT NULL CHECK (target_type IN ('preference', 'inference', 'constraint', 'bundle')),
    target_id UUID NULL,
    old_value JSONB NULL,
    new_value JSONB NULL,
    reason_code TEXT NULL,
    confidence_delta INT NULL, -- For tracking confidence changes
    metadata JSONB NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_user_preference_audit_tenant_user
    ON public.user_preference_audit (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_user_preference_audit_action
    ON public.user_preference_audit (action);

CREATE INDEX IF NOT EXISTS idx_user_preference_audit_target
    ON public.user_preference_audit (target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_user_preference_audit_created
    ON public.user_preference_audit (created_at DESC);

-- ===========================================================================
-- 7. ROW LEVEL SECURITY
-- ===========================================================================

-- Enable RLS on all tables
ALTER TABLE public.preference_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_preference_inferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_constraints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_preference_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_preference_audit ENABLE ROW LEVEL SECURITY;

-- preference_categories: Public read for all authenticated users
DROP POLICY IF EXISTS preference_categories_select ON public.preference_categories;
CREATE POLICY preference_categories_select ON public.preference_categories
    FOR SELECT
    TO authenticated
    USING (TRUE);

-- user_preferences: User owns their preferences
DROP POLICY IF EXISTS user_preferences_select ON public.user_preferences;
CREATE POLICY user_preferences_select ON public.user_preferences
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS user_preferences_insert ON public.user_preferences;
CREATE POLICY user_preferences_insert ON public.user_preferences
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS user_preferences_update ON public.user_preferences;
CREATE POLICY user_preferences_update ON public.user_preferences
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

DROP POLICY IF EXISTS user_preferences_delete ON public.user_preferences;
CREATE POLICY user_preferences_delete ON public.user_preferences
    FOR DELETE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- user_preference_inferences: User owns their inferences
DROP POLICY IF EXISTS user_preference_inferences_select ON public.user_preference_inferences;
CREATE POLICY user_preference_inferences_select ON public.user_preference_inferences
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS user_preference_inferences_insert ON public.user_preference_inferences;
CREATE POLICY user_preference_inferences_insert ON public.user_preference_inferences
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS user_preference_inferences_update ON public.user_preference_inferences;
CREATE POLICY user_preference_inferences_update ON public.user_preference_inferences
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

DROP POLICY IF EXISTS user_preference_inferences_delete ON public.user_preference_inferences;
CREATE POLICY user_preference_inferences_delete ON public.user_preference_inferences
    FOR DELETE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- user_constraints: User owns their constraints
DROP POLICY IF EXISTS user_constraints_select ON public.user_constraints;
CREATE POLICY user_constraints_select ON public.user_constraints
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS user_constraints_insert ON public.user_constraints;
CREATE POLICY user_constraints_insert ON public.user_constraints
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS user_constraints_update ON public.user_constraints;
CREATE POLICY user_constraints_update ON public.user_constraints
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

DROP POLICY IF EXISTS user_constraints_delete ON public.user_constraints;
CREATE POLICY user_constraints_delete ON public.user_constraints
    FOR DELETE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- user_preference_bundles: User owns their bundles
DROP POLICY IF EXISTS user_preference_bundles_select ON public.user_preference_bundles;
CREATE POLICY user_preference_bundles_select ON public.user_preference_bundles
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS user_preference_bundles_insert ON public.user_preference_bundles;
CREATE POLICY user_preference_bundles_insert ON public.user_preference_bundles
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS user_preference_bundles_update ON public.user_preference_bundles;
CREATE POLICY user_preference_bundles_update ON public.user_preference_bundles
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

-- user_preference_audit: User can view their audit history
DROP POLICY IF EXISTS user_preference_audit_select ON public.user_preference_audit;
CREATE POLICY user_preference_audit_select ON public.user_preference_audit
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS user_preference_audit_insert ON public.user_preference_audit;
CREATE POLICY user_preference_audit_insert ON public.user_preference_audit
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- ===========================================================================
-- 8. RPC FUNCTIONS
-- ===========================================================================

-- 8.1 preference_set - Set an explicit preference (with audit)
CREATE OR REPLACE FUNCTION public.preference_set(
    p_category TEXT,
    p_key TEXT,
    p_value JSONB,
    p_priority INT DEFAULT 1,
    p_scope TEXT DEFAULT 'global',
    p_scope_domain TEXT DEFAULT NULL
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
    v_old_value JSONB;
    v_action TEXT;
BEGIN
    -- Validate category
    IF NOT EXISTS (SELECT 1 FROM public.preference_categories WHERE key = p_category) THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_CATEGORY',
            'message', format('Category %s does not exist', p_category)
        );
    END IF;

    -- Validate priority
    IF p_priority < 0 OR p_priority > 2 THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_PRIORITY',
            'message', 'Priority must be 0 (low), 1 (medium), or 2 (high)'
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

    -- Check for existing preference
    SELECT id, preference_value INTO v_pref_id, v_old_value
    FROM public.user_preferences
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND category = p_category
      AND preference_key = p_key
      AND scope = p_scope
      AND (scope_domain = p_scope_domain OR (scope_domain IS NULL AND p_scope_domain IS NULL));

    IF v_pref_id IS NOT NULL THEN
        v_action := 'preference_updated';
        -- Update existing preference
        UPDATE public.user_preferences
        SET preference_value = p_value,
            priority = p_priority,
            confidence = 100, -- Explicit always 100
            last_confirmed_at = NOW(),
            updated_at = NOW()
        WHERE id = v_pref_id;
    ELSE
        v_action := 'preference_created';
        -- Insert new preference
        INSERT INTO public.user_preferences (
            tenant_id, user_id, category, preference_key, preference_value,
            priority, source, scope, scope_domain, confidence, last_confirmed_at
        ) VALUES (
            v_tenant_id, v_user_id, p_category, p_key, p_value,
            p_priority, 'explicit', p_scope, p_scope_domain, 100, NOW()
        )
        RETURNING id INTO v_pref_id;
    END IF;

    -- Write audit log
    INSERT INTO public.user_preference_audit (
        tenant_id, user_id, action, target_type, target_id,
        old_value, new_value, reason_code
    ) VALUES (
        v_tenant_id, v_user_id, v_action, 'preference', v_pref_id,
        v_old_value, p_value, 'user_explicit_set'
    );

    RETURN jsonb_build_object(
        'ok', true,
        'id', v_pref_id,
        'category', p_category,
        'key', p_key,
        'action', v_action
    );
END;
$$;

-- 8.2 preference_delete - Delete an explicit preference
CREATE OR REPLACE FUNCTION public.preference_delete(
    p_category TEXT,
    p_key TEXT,
    p_scope TEXT DEFAULT 'global',
    p_scope_domain TEXT DEFAULT NULL
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
    v_old_value JSONB;
    v_deleted_count INT;
BEGIN
    -- Derive tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
    END IF;

    -- Derive user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Get existing preference for audit
    SELECT id, preference_value INTO v_pref_id, v_old_value
    FROM public.user_preferences
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND category = p_category
      AND preference_key = p_key
      AND scope = p_scope
      AND (scope_domain = p_scope_domain OR (scope_domain IS NULL AND p_scope_domain IS NULL));

    IF v_pref_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'NOT_FOUND',
            'message', 'Preference not found'
        );
    END IF;

    -- Delete preference
    DELETE FROM public.user_preferences WHERE id = v_pref_id;
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

    -- Write audit log
    INSERT INTO public.user_preference_audit (
        tenant_id, user_id, action, target_type, target_id,
        old_value, new_value, reason_code
    ) VALUES (
        v_tenant_id, v_user_id, 'preference_deleted', 'preference', v_pref_id,
        v_old_value, NULL, 'user_explicit_delete'
    );

    RETURN jsonb_build_object(
        'ok', true,
        'deleted', v_deleted_count > 0,
        'id', v_pref_id
    );
END;
$$;

-- 8.3 constraint_set - Set a user constraint
CREATE OR REPLACE FUNCTION public.constraint_set(
    p_type TEXT,
    p_key TEXT,
    p_value JSONB,
    p_severity TEXT DEFAULT 'hard',
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
    v_constraint_id UUID;
    v_old_value JSONB;
    v_action TEXT;
BEGIN
    -- Validate constraint type
    IF p_type NOT IN ('topic_avoid', 'domain_downrank', 'timing', 'role_limit', 'contact_limit', 'content_filter', 'safety') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_CONSTRAINT_TYPE',
            'message', 'Invalid constraint type'
        );
    END IF;

    -- Validate severity
    IF p_severity NOT IN ('hard', 'soft') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_SEVERITY',
            'message', 'Severity must be hard or soft'
        );
    END IF;

    -- Derive tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
    END IF;

    -- Derive user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Check for existing constraint
    SELECT id, constraint_value INTO v_constraint_id, v_old_value
    FROM public.user_constraints
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND constraint_type = p_type
      AND constraint_key = p_key;

    IF v_constraint_id IS NOT NULL THEN
        v_action := 'constraint_updated';
        -- Update existing constraint
        UPDATE public.user_constraints
        SET constraint_value = p_value,
            severity = p_severity,
            reason = p_reason,
            active = TRUE,
            updated_at = NOW()
        WHERE id = v_constraint_id;
    ELSE
        v_action := 'constraint_created';
        -- Insert new constraint
        INSERT INTO public.user_constraints (
            tenant_id, user_id, constraint_type, constraint_key, constraint_value,
            severity, reason, source, active
        ) VALUES (
            v_tenant_id, v_user_id, p_type, p_key, p_value,
            p_severity, p_reason, 'explicit', TRUE
        )
        RETURNING id INTO v_constraint_id;
    END IF;

    -- Write audit log
    INSERT INTO public.user_preference_audit (
        tenant_id, user_id, action, target_type, target_id,
        old_value, new_value, reason_code
    ) VALUES (
        v_tenant_id, v_user_id, v_action, 'constraint', v_constraint_id,
        v_old_value, p_value, 'user_explicit_set'
    );

    RETURN jsonb_build_object(
        'ok', true,
        'id', v_constraint_id,
        'type', p_type,
        'key', p_key,
        'action', v_action
    );
END;
$$;

-- 8.4 constraint_delete - Delete/deactivate a constraint
CREATE OR REPLACE FUNCTION public.constraint_delete(
    p_type TEXT,
    p_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_constraint_id UUID;
    v_old_value JSONB;
BEGIN
    -- Derive tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
    END IF;

    -- Derive user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Get existing constraint
    SELECT id, constraint_value INTO v_constraint_id, v_old_value
    FROM public.user_constraints
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND constraint_type = p_type
      AND constraint_key = p_key;

    IF v_constraint_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'NOT_FOUND',
            'message', 'Constraint not found'
        );
    END IF;

    -- Delete constraint
    DELETE FROM public.user_constraints WHERE id = v_constraint_id;

    -- Write audit log
    INSERT INTO public.user_preference_audit (
        tenant_id, user_id, action, target_type, target_id,
        old_value, new_value, reason_code
    ) VALUES (
        v_tenant_id, v_user_id, 'constraint_deleted', 'constraint', v_constraint_id,
        v_old_value, NULL, 'user_explicit_delete'
    );

    RETURN jsonb_build_object(
        'ok', true,
        'deleted', true,
        'id', v_constraint_id
    );
END;
$$;

-- 8.5 preference_bundle_get - Get the user's preference bundle
CREATE OR REPLACE FUNCTION public.preference_bundle_get()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_bundle RECORD;
    v_preferences JSONB;
    v_inferences JSONB;
    v_constraints JSONB;
    v_avg_confidence NUMERIC;
BEGIN
    -- Derive tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
    END IF;

    -- Derive user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Get explicit preferences
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', id,
                'category', category,
                'key', preference_key,
                'value', preference_value,
                'priority', priority,
                'source', source,
                'scope', scope,
                'scope_domain', scope_domain,
                'confidence', confidence,
                'last_confirmed_at', last_confirmed_at
            )
            ORDER BY priority DESC, category, preference_key
        ),
        '[]'::JSONB
    )
    INTO v_preferences
    FROM public.user_preferences
    WHERE tenant_id = v_tenant_id AND user_id = v_user_id;

    -- Get inferred preferences
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', id,
                'category', category,
                'key', preference_key,
                'value', preference_value,
                'confidence', confidence,
                'evidence_count', evidence_count,
                'scope', scope,
                'scope_domain', scope_domain,
                'inferred_at', inferred_at,
                'last_reinforced_at', last_reinforced_at
            )
            ORDER BY confidence DESC, category, preference_key
        ),
        '[]'::JSONB
    )
    INTO v_inferences
    FROM public.user_preference_inferences
    WHERE tenant_id = v_tenant_id AND user_id = v_user_id;

    -- Get active constraints
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', id,
                'type', constraint_type,
                'key', constraint_key,
                'value', constraint_value,
                'severity', severity,
                'reason', reason,
                'source', source
            )
            ORDER BY severity DESC, constraint_type, constraint_key
        ),
        '[]'::JSONB
    )
    INTO v_constraints
    FROM public.user_constraints
    WHERE tenant_id = v_tenant_id AND user_id = v_user_id AND active = TRUE;

    -- Calculate average confidence
    SELECT AVG(confidence) INTO v_avg_confidence
    FROM (
        SELECT confidence FROM public.user_preferences WHERE tenant_id = v_tenant_id AND user_id = v_user_id
        UNION ALL
        SELECT confidence FROM public.user_preference_inferences WHERE tenant_id = v_tenant_id AND user_id = v_user_id
    ) combined;

    RETURN jsonb_build_object(
        'ok', true,
        'preferences', v_preferences,
        'inferences', v_inferences,
        'constraints', v_constraints,
        'confidence_level', COALESCE(ROUND(v_avg_confidence), 0),
        'preference_count', jsonb_array_length(v_preferences),
        'inference_count', jsonb_array_length(v_inferences),
        'constraint_count', jsonb_array_length(v_constraints),
        'generated_at', NOW()
    );
END;
$$;

-- 8.6 preference_confirm - Confirm/reinforce a preference (increases stability)
CREATE OR REPLACE FUNCTION public.preference_confirm(
    p_preference_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_pref RECORD;
BEGIN
    -- Derive tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
    END IF;

    -- Derive user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Find and update preference
    UPDATE public.user_preferences
    SET last_confirmed_at = NOW(),
        updated_at = NOW()
    WHERE id = p_preference_id
      AND tenant_id = v_tenant_id
      AND user_id = v_user_id
    RETURNING * INTO v_pref;

    IF v_pref IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'NOT_FOUND',
            'message', 'Preference not found'
        );
    END IF;

    -- Write audit log
    INSERT INTO public.user_preference_audit (
        tenant_id, user_id, action, target_type, target_id, reason_code
    ) VALUES (
        v_tenant_id, v_user_id, 'preference_confirmed', 'preference', p_preference_id, 'user_confirmation'
    );

    RETURN jsonb_build_object(
        'ok', true,
        'id', p_preference_id,
        'confirmed_at', NOW()
    );
END;
$$;

-- 8.7 inference_reinforce - Reinforce an inferred preference (increases confidence)
CREATE OR REPLACE FUNCTION public.inference_reinforce(
    p_inference_id UUID,
    p_evidence TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_inference RECORD;
    v_new_confidence INT;
    v_old_confidence INT;
BEGIN
    -- Derive tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
    END IF;

    -- Derive user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Get current inference
    SELECT * INTO v_inference
    FROM public.user_preference_inferences
    WHERE id = p_inference_id
      AND tenant_id = v_tenant_id
      AND user_id = v_user_id;

    IF v_inference IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'NOT_FOUND',
            'message', 'Inference not found'
        );
    END IF;

    v_old_confidence := v_inference.confidence;
    -- Increase confidence by 5, capped at 85 (inferred never reaches max)
    v_new_confidence := LEAST(v_inference.confidence + 5, 85);

    -- Update inference
    UPDATE public.user_preference_inferences
    SET confidence = v_new_confidence,
        evidence_count = evidence_count + 1,
        evidence = CASE
            WHEN p_evidence IS NOT NULL
            THEN evidence || jsonb_build_object('type', 'reinforcement', 'value', p_evidence, 'at', NOW())
            ELSE evidence
        END,
        last_reinforced_at = NOW(),
        updated_at = NOW()
    WHERE id = p_inference_id;

    -- Write audit log
    INSERT INTO public.user_preference_audit (
        tenant_id, user_id, action, target_type, target_id,
        confidence_delta, reason_code
    ) VALUES (
        v_tenant_id, v_user_id, 'inference_reinforced', 'inference', p_inference_id,
        v_new_confidence - v_old_confidence, 'user_reinforcement'
    );

    RETURN jsonb_build_object(
        'ok', true,
        'id', p_inference_id,
        'old_confidence', v_old_confidence,
        'new_confidence', v_new_confidence,
        'delta', v_new_confidence - v_old_confidence
    );
END;
$$;

-- 8.8 inference_downgrade - Downgrade an inferred preference (user correction)
CREATE OR REPLACE FUNCTION public.inference_downgrade(
    p_inference_id UUID,
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
    v_inference RECORD;
    v_new_confidence INT;
    v_old_confidence INT;
BEGIN
    -- Derive tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
    END IF;

    -- Derive user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Get current inference
    SELECT * INTO v_inference
    FROM public.user_preference_inferences
    WHERE id = p_inference_id
      AND tenant_id = v_tenant_id
      AND user_id = v_user_id;

    IF v_inference IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'NOT_FOUND',
            'message', 'Inference not found'
        );
    END IF;

    v_old_confidence := v_inference.confidence;
    -- Decrease confidence by 20 (corrections are significant per spec)
    v_new_confidence := GREATEST(v_inference.confidence - 20, 0);

    IF v_new_confidence = 0 THEN
        -- Delete inference if confidence drops to 0
        DELETE FROM public.user_preference_inferences WHERE id = p_inference_id;

        -- Write audit log
        INSERT INTO public.user_preference_audit (
            tenant_id, user_id, action, target_type, target_id,
            old_value, confidence_delta, reason_code, metadata
        ) VALUES (
            v_tenant_id, v_user_id, 'inference_downgraded', 'inference', p_inference_id,
            to_jsonb(v_inference), -v_old_confidence, 'user_correction',
            jsonb_build_object('deleted', true, 'reason', p_reason)
        );

        RETURN jsonb_build_object(
            'ok', true,
            'id', p_inference_id,
            'deleted', true,
            'reason', 'Confidence dropped to 0'
        );
    ELSE
        -- Update inference
        UPDATE public.user_preference_inferences
        SET confidence = v_new_confidence,
            evidence = evidence || jsonb_build_object('type', 'correction', 'reason', p_reason, 'at', NOW()),
            updated_at = NOW()
        WHERE id = p_inference_id;

        -- Write audit log
        INSERT INTO public.user_preference_audit (
            tenant_id, user_id, action, target_type, target_id,
            confidence_delta, reason_code, metadata
        ) VALUES (
            v_tenant_id, v_user_id, 'inference_downgraded', 'inference', p_inference_id,
            v_new_confidence - v_old_confidence, 'user_correction',
            jsonb_build_object('reason', p_reason)
        );

        RETURN jsonb_build_object(
            'ok', true,
            'id', p_inference_id,
            'old_confidence', v_old_confidence,
            'new_confidence', v_new_confidence,
            'delta', v_new_confidence - v_old_confidence
        );
    END IF;
END;
$$;

-- 8.9 preference_get_audit - Get preference audit history
CREATE OR REPLACE FUNCTION public.preference_get_audit(
    p_limit INT DEFAULT 50,
    p_offset INT DEFAULT 0,
    p_target_type TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_audit JSONB;
    v_total INT;
BEGIN
    -- Derive tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
    END IF;

    -- Derive user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Cap limits
    IF p_limit IS NULL OR p_limit < 1 THEN p_limit := 50; END IF;
    IF p_limit > 100 THEN p_limit := 100; END IF;
    IF p_offset IS NULL OR p_offset < 0 THEN p_offset := 0; END IF;

    -- Get total count
    SELECT COUNT(*) INTO v_total
    FROM public.user_preference_audit
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND (p_target_type IS NULL OR target_type = p_target_type);

    -- Get audit entries
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', id,
                'action', action,
                'target_type', target_type,
                'target_id', target_id,
                'old_value', old_value,
                'new_value', new_value,
                'reason_code', reason_code,
                'confidence_delta', confidence_delta,
                'metadata', metadata,
                'created_at', created_at
            )
            ORDER BY created_at DESC
        ),
        '[]'::JSONB
    )
    INTO v_audit
    FROM public.user_preference_audit
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND (p_target_type IS NULL OR target_type = p_target_type)
    ORDER BY created_at DESC
    LIMIT p_limit
    OFFSET p_offset;

    RETURN jsonb_build_object(
        'ok', true,
        'audit', v_audit,
        'pagination', jsonb_build_object(
            'limit', p_limit,
            'offset', p_offset,
            'total', v_total,
            'has_more', (p_offset + p_limit) < v_total
        )
    );
END;
$$;

-- ===========================================================================
-- 9. PERMISSIONS
-- ===========================================================================

-- RPC functions: callable by authenticated users
GRANT EXECUTE ON FUNCTION public.preference_set(TEXT, TEXT, JSONB, INT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.preference_delete(TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.constraint_set(TEXT, TEXT, JSONB, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.constraint_delete(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.preference_bundle_get() TO authenticated;
GRANT EXECUTE ON FUNCTION public.preference_confirm(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.inference_reinforce(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.inference_downgrade(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.preference_get_audit(INT, INT, TEXT) TO authenticated;

-- Tables: allow authenticated users to interact (RLS enforces row-level access)
GRANT SELECT ON public.preference_categories TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_preferences TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_preference_inferences TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_constraints TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.user_preference_bundles TO authenticated;
GRANT SELECT, INSERT ON public.user_preference_audit TO authenticated;

-- ===========================================================================
-- 10. COMMENTS
-- ===========================================================================

COMMENT ON TABLE public.preference_categories IS 'VTID-01119: Canonical preference categories (health, communication, social, economic, autonomy, privacy)';
COMMENT ON TABLE public.user_preferences IS 'VTID-01119: Explicit user preferences with high confidence';
COMMENT ON TABLE public.user_preference_inferences IS 'VTID-01119: Inferred preferences from user behavior (capped at 85% confidence)';
COMMENT ON TABLE public.user_constraints IS 'VTID-01119: Hard constraints that always override preferences';
COMMENT ON TABLE public.user_preference_bundles IS 'VTID-01119: Computed preference bundles for downstream intelligence';
COMMENT ON TABLE public.user_preference_audit IS 'VTID-01119: Audit log for all preference changes (explainability + governance)';

COMMENT ON FUNCTION public.preference_set IS 'VTID-01119: Set an explicit user preference with audit';
COMMENT ON FUNCTION public.preference_delete IS 'VTID-01119: Delete an explicit user preference';
COMMENT ON FUNCTION public.constraint_set IS 'VTID-01119: Set a user constraint (hard boundary)';
COMMENT ON FUNCTION public.constraint_delete IS 'VTID-01119: Delete a user constraint';
COMMENT ON FUNCTION public.preference_bundle_get IS 'VTID-01119: Get the full preference bundle for current user';
COMMENT ON FUNCTION public.preference_confirm IS 'VTID-01119: Confirm/reinforce a preference (increases stability)';
COMMENT ON FUNCTION public.inference_reinforce IS 'VTID-01119: Reinforce an inferred preference (increases confidence)';
COMMENT ON FUNCTION public.inference_downgrade IS 'VTID-01119: Downgrade an inferred preference (user correction)';
COMMENT ON FUNCTION public.preference_get_audit IS 'VTID-01119: Get preference audit history';
