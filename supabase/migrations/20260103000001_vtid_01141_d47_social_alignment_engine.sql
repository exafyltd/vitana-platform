-- Migration: 20260103000001_vtid_01141_d47_social_alignment_engine.sql
-- Purpose: VTID-01141 D47 Proactive Social & Community Alignment Engine
-- Date: 2026-01-03
--
-- Implements:
--   - Social alignment suggestions storage
--   - Matching logic for people, groups, events, services, activities
--   - Privacy-safe suggestion tracking
--   - Explainability metadata
--
-- D47 Purpose:
--   Anticipate social needs and alignment opportunities, proactively surfacing
--   relevant people, groups, events, or activities that improve wellbeing,
--   belonging, and long-term quality of life.
--
-- Hard Constraints (GOVERNANCE):
--   - Memory-first approach
--   - Consent-by-design (suggestions only)
--   - No forced matchmaking
--   - No social graph exposure
--   - Explainability mandatory
--   - No cold-start hallucinations
--   - All outputs logged to OASIS
--   - No schema-breaking changes
--
-- Dependencies:
--   - VTID-01129 (D35 Social Context)
--   - VTID-01087 (Relationship Graph Memory)
--   - VTID-01084 (Community Personalization)
--   - VTID-01101 (Phase A-Fix) - tenant/user/role helpers
--   - VTID-01102 (Phase B-Fix) - runtime context bridge

-- ===========================================================================
-- A. Alignment Domain Types
-- ===========================================================================

-- Alignment domains (spec section 3)
DO $$ BEGIN
    CREATE TYPE public.alignment_domain AS ENUM (
        'people',       -- 1:1 connections
        'group',        -- Groups / Communities
        'event',        -- Events / Meetups
        'live_room',    -- Live Rooms
        'service',      -- Services / Professionals
        'activity'      -- Activities / Rituals
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Suggested action types
DO $$ BEGIN
    CREATE TYPE public.alignment_action AS ENUM (
        'view',         -- View details
        'connect',      -- Initiate connection
        'save',         -- Save for later
        'not_now'       -- Dismiss temporarily
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Suggestion status
DO $$ BEGIN
    CREATE TYPE public.alignment_status AS ENUM (
        'pending',      -- Not yet shown to user
        'shown',        -- Shown to user
        'acted',        -- User took suggested action
        'dismissed',    -- User dismissed
        'expired'       -- Time-based expiration
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- ===========================================================================
-- B. social_alignment_suggestions - Core storage table
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.social_alignment_suggestions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,

    -- Core alignment data
    alignment_domain public.alignment_domain NOT NULL,
    target_node_id UUID REFERENCES public.relationship_nodes(id) ON DELETE CASCADE,

    -- Confidence and scoring
    confidence INT NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
    relevance_score INT NOT NULL CHECK (relevance_score >= 0 AND relevance_score <= 100),

    -- Explainability (spec section 5 - mandatory)
    why_now TEXT NOT NULL,
    shared_signals JSONB NOT NULL DEFAULT '[]',

    -- Action tracking
    suggested_action public.alignment_action NOT NULL DEFAULT 'view',
    dismissible BOOLEAN NOT NULL DEFAULT true,
    status public.alignment_status NOT NULL DEFAULT 'pending',

    -- Context references (spec section 2)
    predictive_window_id UUID,      -- Link to D45 predictive window
    guidance_context_id UUID,       -- Link to D46 guidance context
    memory_refs JSONB NOT NULL DEFAULT '[]',  -- Memory item references

    -- Timing context
    contextual_timing TEXT,         -- Why this timing is appropriate
    social_load_check JSONB,        -- Social overload assessment

    -- Lifecycle management
    valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_until TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),

    -- User action tracking
    shown_at TIMESTAMPTZ,
    acted_at TIMESTAMPTZ,
    dismissed_at TIMESTAMPTZ,
    user_feedback JSONB,

    -- Metadata
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Composite uniqueness: one active suggestion per user per target
    CONSTRAINT unique_active_suggestion UNIQUE (tenant_id, user_id, target_node_id, status)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_social_alignment_tenant_user
    ON public.social_alignment_suggestions (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_social_alignment_domain
    ON public.social_alignment_suggestions (alignment_domain);

CREATE INDEX IF NOT EXISTS idx_social_alignment_status
    ON public.social_alignment_suggestions (status);

CREATE INDEX IF NOT EXISTS idx_social_alignment_confidence
    ON public.social_alignment_suggestions (confidence DESC);

CREATE INDEX IF NOT EXISTS idx_social_alignment_relevance
    ON public.social_alignment_suggestions (relevance_score DESC);

CREATE INDEX IF NOT EXISTS idx_social_alignment_valid_until
    ON public.social_alignment_suggestions (valid_until);

CREATE INDEX IF NOT EXISTS idx_social_alignment_target_node
    ON public.social_alignment_suggestions (target_node_id);

-- ===========================================================================
-- C. social_alignment_signals - Shared alignment signals catalog
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.social_alignment_signals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,

    -- Signal definition
    signal_key TEXT NOT NULL,
    signal_type TEXT NOT NULL CHECK (
        signal_type IN ('interest', 'value', 'goal', 'preference', 'behavior')
    ),
    display_name TEXT NOT NULL,
    description TEXT,

    -- Matching weights
    alignment_weight NUMERIC(3,2) NOT NULL DEFAULT 1.0 CHECK (
        alignment_weight >= 0 AND alignment_weight <= 2
    ),

    -- Metadata
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- One signal per key per tenant
    CONSTRAINT unique_signal_key UNIQUE (tenant_id, signal_key)
);

-- Index for signal lookups
CREATE INDEX IF NOT EXISTS idx_social_alignment_signals_type
    ON public.social_alignment_signals (signal_type);

-- ===========================================================================
-- D. social_alignment_audit - Audit trail for D59 compliance
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.social_alignment_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,

    -- Action tracking
    action TEXT NOT NULL CHECK (
        action IN (
            'suggestion_generated',
            'suggestion_shown',
            'suggestion_acted',
            'suggestion_dismissed',
            'suggestion_expired',
            'batch_generated',
            'batch_cleanup'
        )
    ),

    -- Target reference
    suggestion_id UUID REFERENCES public.social_alignment_suggestions(id) ON DELETE SET NULL,
    batch_id TEXT,

    -- Context
    alignment_domain public.alignment_domain,
    confidence INT,
    relevance_score INT,

    -- Audit details
    details JSONB DEFAULT '{}',

    -- Timestamp
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for audit queries
CREATE INDEX IF NOT EXISTS idx_social_alignment_audit_tenant_user
    ON public.social_alignment_audit (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_social_alignment_audit_action
    ON public.social_alignment_audit (action);

CREATE INDEX IF NOT EXISTS idx_social_alignment_audit_created
    ON public.social_alignment_audit (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_social_alignment_audit_suggestion
    ON public.social_alignment_audit (suggestion_id);

-- ===========================================================================
-- E. RLS Policies
-- ===========================================================================

-- Enable RLS
ALTER TABLE public.social_alignment_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_alignment_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_alignment_audit ENABLE ROW LEVEL SECURITY;

-- social_alignment_suggestions: user + tenant isolation
DROP POLICY IF EXISTS social_alignment_suggestions_select ON public.social_alignment_suggestions;
CREATE POLICY social_alignment_suggestions_select ON public.social_alignment_suggestions
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS social_alignment_suggestions_insert ON public.social_alignment_suggestions;
CREATE POLICY social_alignment_suggestions_insert ON public.social_alignment_suggestions
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS social_alignment_suggestions_update ON public.social_alignment_suggestions;
CREATE POLICY social_alignment_suggestions_update ON public.social_alignment_suggestions
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

DROP POLICY IF EXISTS social_alignment_suggestions_delete ON public.social_alignment_suggestions;
CREATE POLICY social_alignment_suggestions_delete ON public.social_alignment_suggestions
    FOR DELETE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- social_alignment_signals: tenant-wide access (read-only for users)
DROP POLICY IF EXISTS social_alignment_signals_select ON public.social_alignment_signals;
CREATE POLICY social_alignment_signals_select ON public.social_alignment_signals
    FOR SELECT
    TO authenticated
    USING (tenant_id = public.current_tenant_id());

-- Only service role can manage signals
DROP POLICY IF EXISTS social_alignment_signals_insert ON public.social_alignment_signals;
CREATE POLICY social_alignment_signals_insert ON public.social_alignment_signals
    FOR INSERT
    TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id());

-- social_alignment_audit: user + tenant isolation (read-only for users)
DROP POLICY IF EXISTS social_alignment_audit_select ON public.social_alignment_audit;
CREATE POLICY social_alignment_audit_select ON public.social_alignment_audit
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS social_alignment_audit_insert ON public.social_alignment_audit;
CREATE POLICY social_alignment_audit_insert ON public.social_alignment_audit
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- ===========================================================================
-- F. RPC Functions
-- ===========================================================================

-- ===========================================================================
-- F.1 alignment_generate_suggestions - Generate alignment suggestions for user
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.alignment_generate_suggestions(
    p_max_suggestions INT DEFAULT 5,
    p_alignment_domains TEXT[] DEFAULT NULL,
    p_min_relevance INT DEFAULT 75,
    p_min_shared_signals INT DEFAULT 2
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_comfort_profile JSONB;
    v_social_energy INT;
    v_suggestions JSONB := '[]'::JSONB;
    v_candidate RECORD;
    v_shared_signals JSONB;
    v_signal_count INT;
    v_why_now TEXT;
    v_relevance_score INT;
    v_confidence INT;
    v_domain public.alignment_domain;
    v_batch_id TEXT;
    v_suggestion_id UUID;
    v_inserted_count INT := 0;
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

    -- Cap max suggestions
    p_max_suggestions := LEAST(GREATEST(p_max_suggestions, 1), 20);

    -- Get user's social comfort profile for social load check
    SELECT profile INTO v_comfort_profile
    FROM (
        SELECT jsonb_build_object(
            'social_energy', social_energy,
            'new_people', new_people,
            'new_people_confidence', new_people_confidence,
            'large_group', large_group
        ) as profile
        FROM public.social_comfort_profiles
        WHERE tenant_id = v_tenant_id AND user_id = v_user_id
    ) sub;

    IF v_comfort_profile IS NULL THEN
        -- Use defaults if no profile exists
        v_comfort_profile := jsonb_build_object(
            'social_energy', 50,
            'new_people', 'neutral',
            'new_people_confidence', 50,
            'large_group', 'unknown'
        );
    END IF;

    v_social_energy := (v_comfort_profile->>'social_energy')::INT;

    -- Check social overload (spec section 4)
    IF v_social_energy < 20 THEN
        RETURN jsonb_build_object(
            'ok', true,
            'suggestions', '[]'::JSONB,
            'reason', 'social_energy_low',
            'message', 'User has low social energy, no suggestions generated'
        );
    END IF;

    -- Generate batch ID for tracking
    v_batch_id := 'd47_' || gen_random_uuid()::TEXT;

    -- Expire old pending suggestions
    UPDATE public.social_alignment_suggestions
    SET status = 'expired', updated_at = NOW()
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND status = 'pending'
      AND valid_until < NOW();

    -- Find candidates from relationship graph
    FOR v_candidate IN
        SELECT
            n.id as node_id,
            n.node_type,
            n.title,
            n.domain,
            n.metadata,
            COALESCE(e.strength, 0) as strength,
            e.relationship_type,
            e.last_seen
        FROM public.relationship_nodes n
        LEFT JOIN public.relationship_edges e ON (
            e.tenant_id = v_tenant_id
            AND e.user_id = v_user_id
            AND (e.to_node_id = n.id OR e.from_node_id = n.id)
        )
        WHERE n.tenant_id = v_tenant_id
          AND n.node_type IN ('person', 'group', 'event', 'service', 'live_room')
          AND NOT EXISTS (
              -- Exclude already active suggestions for this target
              SELECT 1 FROM public.social_alignment_suggestions s
              WHERE s.tenant_id = v_tenant_id
                AND s.user_id = v_user_id
                AND s.target_node_id = n.id
                AND s.status IN ('pending', 'shown')
          )
        ORDER BY COALESCE(e.strength, 0) DESC, e.last_seen DESC NULLS LAST
        LIMIT p_max_suggestions * 3  -- Get more candidates for filtering
    LOOP
        -- Map node_type to alignment_domain
        v_domain := CASE v_candidate.node_type
            WHEN 'person' THEN 'people'::public.alignment_domain
            WHEN 'group' THEN 'group'::public.alignment_domain
            WHEN 'event' THEN 'event'::public.alignment_domain
            WHEN 'service' THEN 'service'::public.alignment_domain
            WHEN 'live_room' THEN 'live_room'::public.alignment_domain
            ELSE 'activity'::public.alignment_domain
        END;

        -- Filter by requested domains
        IF p_alignment_domains IS NOT NULL AND NOT (v_domain::TEXT = ANY(p_alignment_domains)) THEN
            CONTINUE;
        END IF;

        -- Calculate shared signals (simplified - based on domain and metadata)
        v_shared_signals := '[]'::JSONB;

        -- Add domain signal if matches user's active domains
        IF v_candidate.domain IS NOT NULL THEN
            v_shared_signals := v_shared_signals || jsonb_build_array(
                jsonb_build_object('type', 'interest', 'ref', 'domain:' || v_candidate.domain)
            );
        END IF;

        -- Add strength-based signals
        IF v_candidate.strength >= 50 THEN
            v_shared_signals := v_shared_signals || jsonb_build_array(
                jsonb_build_object('type', 'behavior', 'ref', 'strong_connection')
            );
        END IF;

        -- Add recency signals
        IF v_candidate.last_seen IS NOT NULL AND v_candidate.last_seen > NOW() - INTERVAL '7 days' THEN
            v_shared_signals := v_shared_signals || jsonb_build_array(
                jsonb_build_object('type', 'behavior', 'ref', 'recent_interaction')
            );
        END IF;

        v_signal_count := jsonb_array_length(v_shared_signals);

        -- Check minimum shared signals threshold (spec section 4)
        IF v_signal_count < p_min_shared_signals THEN
            CONTINUE;
        END IF;

        -- Calculate relevance score
        v_relevance_score := LEAST(100,
            30 +  -- Base score
            COALESCE(v_candidate.strength, 0) / 2 +  -- Connection strength contributes up to 50
            v_signal_count * 10  -- Each signal adds 10
        );

        -- Check minimum relevance threshold (spec section 4)
        IF v_relevance_score < p_min_relevance THEN
            CONTINUE;
        END IF;

        -- Calculate confidence
        v_confidence := LEAST(100,
            50 +  -- Base confidence
            v_signal_count * 10 +  -- Signal contribution
            CASE WHEN v_candidate.last_seen > NOW() - INTERVAL '7 days' THEN 20 ELSE 0 END
        );

        -- Generate why_now explanation (spec section 5 - mandatory)
        v_why_now := CASE
            WHEN v_candidate.relationship_type = 'friend' AND v_candidate.strength >= 60 THEN
                'This is a close connection you haven''t interacted with recently. Reconnecting may be supportive.'
            WHEN v_candidate.node_type = 'group' THEN
                'This community aligns with your interests and could provide meaningful connection.'
            WHEN v_candidate.node_type = 'event' THEN
                'This event matches your preferences and is coming up soon.'
            WHEN v_candidate.node_type = 'service' THEN
                'This service aligns with your goals and may be helpful right now.'
            WHEN v_candidate.node_type = 'live_room' THEN
                'This live session is happening now with topics you care about.'
            ELSE
                'Based on your preferences and past interactions, this may be a good match.'
        END;

        -- Insert suggestion
        INSERT INTO public.social_alignment_suggestions (
            tenant_id, user_id,
            alignment_domain, target_node_id,
            confidence, relevance_score,
            why_now, shared_signals,
            suggested_action, dismissible,
            social_load_check,
            valid_from, valid_until
        ) VALUES (
            v_tenant_id, v_user_id,
            v_domain, v_candidate.node_id,
            v_confidence, v_relevance_score,
            v_why_now, v_shared_signals,
            'view', true,
            v_comfort_profile,
            NOW(), NOW() + INTERVAL '24 hours'
        )
        ON CONFLICT (tenant_id, user_id, target_node_id, status) DO NOTHING
        RETURNING id INTO v_suggestion_id;

        IF v_suggestion_id IS NOT NULL THEN
            v_inserted_count := v_inserted_count + 1;

            -- Audit
            INSERT INTO public.social_alignment_audit (
                tenant_id, user_id, action, suggestion_id, batch_id,
                alignment_domain, confidence, relevance_score,
                details
            ) VALUES (
                v_tenant_id, v_user_id, 'suggestion_generated', v_suggestion_id, v_batch_id,
                v_domain, v_confidence, v_relevance_score,
                jsonb_build_object(
                    'target_title', v_candidate.title,
                    'shared_signals_count', v_signal_count,
                    'why_now', v_why_now
                )
            );

            -- Add to result
            v_suggestions := v_suggestions || jsonb_build_array(
                jsonb_build_object(
                    'alignment_id', v_suggestion_id,
                    'alignment_domain', v_domain,
                    'confidence', v_confidence,
                    'why_now', v_why_now,
                    'shared_signals', v_shared_signals,
                    'suggested_action', 'view',
                    'dismissible', true,
                    'target', jsonb_build_object(
                        'node_id', v_candidate.node_id,
                        'title', v_candidate.title,
                        'type', v_candidate.node_type
                    )
                )
            );

            -- Check if we have enough
            IF v_inserted_count >= p_max_suggestions THEN
                EXIT;
            END IF;
        END IF;
    END LOOP;

    -- Audit batch generation
    INSERT INTO public.social_alignment_audit (
        tenant_id, user_id, action, batch_id,
        details
    ) VALUES (
        v_tenant_id, v_user_id, 'batch_generated', v_batch_id,
        jsonb_build_object(
            'suggestions_count', v_inserted_count,
            'social_energy', v_social_energy,
            'min_relevance', p_min_relevance,
            'min_shared_signals', p_min_shared_signals
        )
    );

    RETURN jsonb_build_object(
        'ok', true,
        'batch_id', v_batch_id,
        'suggestions', v_suggestions,
        'count', v_inserted_count,
        'social_context', jsonb_build_object(
            'social_energy', v_social_energy,
            'load_check', 'passed'
        )
    );
END;
$$;

-- ===========================================================================
-- F.2 alignment_get_suggestions - Get current suggestions for user
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.alignment_get_suggestions(
    p_status TEXT[] DEFAULT ARRAY['pending', 'shown'],
    p_alignment_domains TEXT[] DEFAULT NULL,
    p_limit INT DEFAULT 10
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_suggestions JSONB;
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

    -- Cap limit
    p_limit := LEAST(GREATEST(p_limit, 1), 50);

    -- Get suggestions with target details
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'alignment_id', s.id,
            'alignment_domain', s.alignment_domain,
            'confidence', s.confidence,
            'why_now', s.why_now,
            'shared_signals', s.shared_signals,
            'suggested_action', s.suggested_action,
            'dismissible', s.dismissible,
            'status', s.status,
            'target', jsonb_build_object(
                'node_id', n.id,
                'title', n.title,
                'type', n.node_type,
                'domain', n.domain,
                'metadata', n.metadata
            ),
            'valid_until', s.valid_until,
            'created_at', s.created_at
        )
        ORDER BY s.relevance_score DESC, s.confidence DESC
    ), '[]'::JSONB)
    INTO v_suggestions
    FROM public.social_alignment_suggestions s
    LEFT JOIN public.relationship_nodes n ON n.id = s.target_node_id
    WHERE s.tenant_id = v_tenant_id
      AND s.user_id = v_user_id
      AND s.status::TEXT = ANY(p_status)
      AND s.valid_until > NOW()
      AND (p_alignment_domains IS NULL OR s.alignment_domain::TEXT = ANY(p_alignment_domains))
    LIMIT p_limit;

    RETURN jsonb_build_object(
        'ok', true,
        'suggestions', v_suggestions,
        'count', jsonb_array_length(v_suggestions)
    );
END;
$$;

-- ===========================================================================
-- F.3 alignment_mark_shown - Mark suggestion as shown to user
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.alignment_mark_shown(
    p_suggestion_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_suggestion RECORD;
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

    -- Get suggestion
    SELECT * INTO v_suggestion
    FROM public.social_alignment_suggestions
    WHERE id = p_suggestion_id
      AND tenant_id = v_tenant_id
      AND user_id = v_user_id;

    IF v_suggestion.id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'NOT_FOUND',
            'message', 'Suggestion not found'
        );
    END IF;

    -- Update status
    UPDATE public.social_alignment_suggestions
    SET status = 'shown', shown_at = NOW(), updated_at = NOW()
    WHERE id = p_suggestion_id;

    -- Audit
    INSERT INTO public.social_alignment_audit (
        tenant_id, user_id, action, suggestion_id,
        alignment_domain, confidence, relevance_score
    ) VALUES (
        v_tenant_id, v_user_id, 'suggestion_shown', p_suggestion_id,
        v_suggestion.alignment_domain, v_suggestion.confidence, v_suggestion.relevance_score
    );

    RETURN jsonb_build_object(
        'ok', true,
        'suggestion_id', p_suggestion_id,
        'status', 'shown'
    );
END;
$$;

-- ===========================================================================
-- F.4 alignment_act_on_suggestion - Record user action on suggestion
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.alignment_act_on_suggestion(
    p_suggestion_id UUID,
    p_action TEXT,
    p_feedback JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_suggestion RECORD;
    v_new_status public.alignment_status;
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

    -- Validate action
    IF p_action NOT IN ('view', 'connect', 'save', 'not_now') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_ACTION',
            'message', 'Action must be one of: view, connect, save, not_now'
        );
    END IF;

    -- Get suggestion
    SELECT * INTO v_suggestion
    FROM public.social_alignment_suggestions
    WHERE id = p_suggestion_id
      AND tenant_id = v_tenant_id
      AND user_id = v_user_id;

    IF v_suggestion.id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'NOT_FOUND',
            'message', 'Suggestion not found'
        );
    END IF;

    -- Determine new status based on action
    v_new_status := CASE p_action
        WHEN 'not_now' THEN 'dismissed'::public.alignment_status
        ELSE 'acted'::public.alignment_status
    END;

    -- Update suggestion
    UPDATE public.social_alignment_suggestions
    SET
        status = v_new_status,
        suggested_action = p_action::public.alignment_action,
        acted_at = CASE WHEN p_action != 'not_now' THEN NOW() ELSE NULL END,
        dismissed_at = CASE WHEN p_action = 'not_now' THEN NOW() ELSE NULL END,
        user_feedback = COALESCE(p_feedback, user_feedback),
        updated_at = NOW()
    WHERE id = p_suggestion_id;

    -- Audit
    INSERT INTO public.social_alignment_audit (
        tenant_id, user_id, action, suggestion_id,
        alignment_domain, confidence, relevance_score,
        details
    ) VALUES (
        v_tenant_id, v_user_id,
        CASE WHEN p_action = 'not_now' THEN 'suggestion_dismissed' ELSE 'suggestion_acted' END,
        p_suggestion_id,
        v_suggestion.alignment_domain, v_suggestion.confidence, v_suggestion.relevance_score,
        jsonb_build_object(
            'user_action', p_action,
            'feedback', p_feedback
        )
    );

    RETURN jsonb_build_object(
        'ok', true,
        'suggestion_id', p_suggestion_id,
        'action', p_action,
        'status', v_new_status
    );
END;
$$;

-- ===========================================================================
-- F.5 alignment_cleanup_expired - Cleanup expired suggestions (service job)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.alignment_cleanup_expired()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_expired_count INT;
BEGIN
    -- Mark expired suggestions
    UPDATE public.social_alignment_suggestions
    SET status = 'expired', updated_at = NOW()
    WHERE status IN ('pending', 'shown')
      AND valid_until < NOW();

    GET DIAGNOSTICS v_expired_count = ROW_COUNT;

    -- Audit if any expired
    IF v_expired_count > 0 THEN
        INSERT INTO public.social_alignment_audit (
            tenant_id, user_id, action,
            details
        )
        SELECT DISTINCT
            tenant_id,
            user_id,
            'suggestion_expired',
            jsonb_build_object('count', v_expired_count)
        FROM public.social_alignment_suggestions
        WHERE status = 'expired'
          AND updated_at >= NOW() - INTERVAL '1 minute';
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'expired_count', v_expired_count
    );
END;
$$;

-- ===========================================================================
-- G. Permissions
-- ===========================================================================

-- RPC functions: callable by authenticated users
GRANT EXECUTE ON FUNCTION public.alignment_generate_suggestions(INT, TEXT[], INT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.alignment_get_suggestions(TEXT[], TEXT[], INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.alignment_mark_shown(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.alignment_act_on_suggestion(UUID, TEXT, JSONB) TO authenticated;

-- Cleanup function: service role only
GRANT EXECUTE ON FUNCTION public.alignment_cleanup_expired() TO service_role;

-- Tables: authenticated users with RLS
GRANT SELECT, INSERT, UPDATE, DELETE ON public.social_alignment_suggestions TO authenticated;
GRANT SELECT ON public.social_alignment_signals TO authenticated;
GRANT SELECT, INSERT ON public.social_alignment_audit TO authenticated;

-- Service role: full access
GRANT ALL ON public.social_alignment_suggestions TO service_role;
GRANT ALL ON public.social_alignment_signals TO service_role;
GRANT ALL ON public.social_alignment_audit TO service_role;

-- ===========================================================================
-- H. Seed Default Signals
-- ===========================================================================

-- Insert default alignment signals (for tenant 00000000-0000-0000-0000-000000000001)
INSERT INTO public.social_alignment_signals (tenant_id, signal_key, signal_type, display_name, description)
VALUES
    ('00000000-0000-0000-0000-000000000001', 'shared_health_goals', 'goal', 'Shared Health Goals', 'Users share similar longevity or health objectives'),
    ('00000000-0000-0000-0000-000000000001', 'similar_lifestyle', 'preference', 'Similar Lifestyle', 'Users have compatible lifestyle preferences'),
    ('00000000-0000-0000-0000-000000000001', 'common_interests', 'interest', 'Common Interests', 'Users share hobbies or interest topics'),
    ('00000000-0000-0000-0000-000000000001', 'location_proximity', 'preference', 'Location Proximity', 'Users are geographically close'),
    ('00000000-0000-0000-0000-000000000001', 'schedule_compatibility', 'preference', 'Schedule Compatibility', 'Users have overlapping availability'),
    ('00000000-0000-0000-0000-000000000001', 'complementary_skills', 'value', 'Complementary Skills', 'Users have skills that complement each other'),
    ('00000000-0000-0000-0000-000000000001', 'positive_history', 'behavior', 'Positive History', 'Users have had positive past interactions'),
    ('00000000-0000-0000-0000-000000000001', 'group_membership', 'behavior', 'Group Membership', 'Users belong to the same groups'),
    ('00000000-0000-0000-0000-000000000001', 'event_attendance', 'behavior', 'Event Attendance', 'Users have attended same events'),
    ('00000000-0000-0000-0000-000000000001', 'value_alignment', 'value', 'Value Alignment', 'Users share core values')
ON CONFLICT (tenant_id, signal_key) DO NOTHING;

-- ===========================================================================
-- I. Comments
-- ===========================================================================

COMMENT ON TABLE public.social_alignment_suggestions IS 'VTID-01141 D47: Proactive social alignment suggestions for users';
COMMENT ON TABLE public.social_alignment_signals IS 'VTID-01141 D47: Catalog of shared alignment signals for matching';
COMMENT ON TABLE public.social_alignment_audit IS 'VTID-01141 D47: Audit trail for alignment suggestions (D59 compliance)';

COMMENT ON FUNCTION public.alignment_generate_suggestions IS 'VTID-01141 D47: Generate alignment suggestions based on matching logic';
COMMENT ON FUNCTION public.alignment_get_suggestions IS 'VTID-01141 D47: Get current alignment suggestions for user';
COMMENT ON FUNCTION public.alignment_mark_shown IS 'VTID-01141 D47: Mark suggestion as shown to user';
COMMENT ON FUNCTION public.alignment_act_on_suggestion IS 'VTID-01141 D47: Record user action on suggestion';
COMMENT ON FUNCTION public.alignment_cleanup_expired IS 'VTID-01141 D47: Cleanup expired suggestions (service job)';
