-- Migration: 20260105_vtid_01146_d46_anticipatory_guidance.sql
-- Purpose: VTID-01146 D46 Anticipatory Guidance DB Schema
-- Date: 2026-01-05
--
-- This migration creates the anticipatory_guidance table for D46
-- Anticipatory Guidance & Pre-emptive Coaching Layer.
--
-- D46 Purpose:
--   Translates predictive windows (D45) into gentle, pre-emptive guidance
--   that helps the user prepare *before* a risk or opportunity window occurs.
--
-- D46 answers: "What would help right now, given what's likely coming?"
--
-- Hard Constraints (GOVERNANCE):
--   - Memory-first approach
--   - Tenant-aware everywhere
--   - No schema-breaking changes
--   - Additive only
--   - All changes traceable to VTID-01146
--
-- Dependencies:
--   - VTID-01139 (D45 Predictive Risk Forecasting)
--   - VTID-01140 (D46 Engine implementation)
--   - VTID-01101 (Phase A-Fix) - tenant/user/role helpers

-- ===========================================================================
-- A. anticipatory_guidance - Core table for D46 guidance outputs
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.anticipatory_guidance (
    -- Primary key
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Tenant & User (mandatory)
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,

    -- Source window reference (D45 predictive window)
    source_window_id UUID,

    -- Guidance mode (STRICT: only these 4 allowed)
    guidance_mode TEXT NOT NULL CHECK (guidance_mode IN (
        'awareness',      -- Surface observation only
        'reflection',     -- Ask a gentle question
        'preparation',    -- Suggest a light, optional step
        'reinforcement'   -- Amplify positive momentum
    )),

    -- Domain (aligned with D44/D45 signal domains)
    domain TEXT NOT NULL CHECK (domain IN (
        'health', 'behavior', 'social', 'cognitive', 'routine', 'emotional', 'financial'
    )),

    -- Confidence score (0-100)
    confidence INTEGER NOT NULL CHECK (confidence >= 0 AND confidence <= 100),

    -- Timing hint for when to surface
    timing_hint TEXT NOT NULL CHECK (timing_hint IN (
        'now',            -- Surface immediately
        'next_24h',       -- Surface within next 24 hours
        'before_window'   -- Surface before the predicted window begins
    )),

    -- Guidance content
    guidance_text TEXT NOT NULL,
    why_this_matters TEXT NOT NULL,

    -- User control
    dismissible BOOLEAN NOT NULL DEFAULT true,

    -- Lineage tracking (for explainability)
    originating_signal_ids JSONB DEFAULT '[]'::jsonb,
    user_preferences_snapshot JSONB DEFAULT '{}'::jsonb,

    -- Status tracking
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',    -- Not yet shown to user
        'surfaced',   -- Shown to user
        'engaged',    -- User engaged with guidance
        'dismissed',  -- User dismissed
        'expired'     -- Time-based expiration
    )),

    -- Relevance scoring
    relevance_score INTEGER CHECK (relevance_score >= 0 AND relevance_score <= 100),

    -- Generation metadata
    generation_rules_version TEXT,

    -- Lifecycle timestamps
    surfaced_at TIMESTAMPTZ,
    engaged_at TIMESTAMPTZ,
    dismissed_at TIMESTAMPTZ,

    -- Metadata (extensible)
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Audit timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ===========================================================================
-- B. Indexes for efficient querying
-- ===========================================================================

-- Primary lookup index: (tenant_id, user_id, created_at)
CREATE INDEX IF NOT EXISTS idx_anticipatory_guidance_tenant_user_created
    ON public.anticipatory_guidance (tenant_id, user_id, created_at DESC);

-- Source window lookup
CREATE INDEX IF NOT EXISTS idx_anticipatory_guidance_source_window
    ON public.anticipatory_guidance (source_window_id);

-- Status filtering
CREATE INDEX IF NOT EXISTS idx_anticipatory_guidance_status
    ON public.anticipatory_guidance (status);

-- Domain filtering
CREATE INDEX IF NOT EXISTS idx_anticipatory_guidance_domain
    ON public.anticipatory_guidance (domain);

-- User + status for active guidance queries
CREATE INDEX IF NOT EXISTS idx_anticipatory_guidance_user_status
    ON public.anticipatory_guidance (user_id, status);

-- Confidence-based ordering
CREATE INDEX IF NOT EXISTS idx_anticipatory_guidance_confidence
    ON public.anticipatory_guidance (confidence DESC);

-- ===========================================================================
-- C. Row Level Security
-- ===========================================================================

-- Enable RLS
ALTER TABLE public.anticipatory_guidance ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only SELECT their own guidance
DROP POLICY IF EXISTS anticipatory_guidance_select_own ON public.anticipatory_guidance;
CREATE POLICY anticipatory_guidance_select_own ON public.anticipatory_guidance
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- Policy: Users can UPDATE their own guidance (status changes, dismiss, etc.)
DROP POLICY IF EXISTS anticipatory_guidance_update_own ON public.anticipatory_guidance;
CREATE POLICY anticipatory_guidance_update_own ON public.anticipatory_guidance
    FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Policy: Service role can INSERT (guidance generation is system-driven)
DROP POLICY IF EXISTS anticipatory_guidance_insert_service ON public.anticipatory_guidance;
CREATE POLICY anticipatory_guidance_insert_service ON public.anticipatory_guidance
    FOR INSERT
    TO service_role
    WITH CHECK (true);

-- Policy: Service role has full access
DROP POLICY IF EXISTS anticipatory_guidance_service_all ON public.anticipatory_guidance;
CREATE POLICY anticipatory_guidance_service_all ON public.anticipatory_guidance
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- ===========================================================================
-- D. Permissions
-- ===========================================================================

-- Authenticated users: read and update their own guidance
GRANT SELECT, UPDATE ON public.anticipatory_guidance TO authenticated;

-- Service role: full access for system operations
GRANT ALL ON public.anticipatory_guidance TO service_role;

-- ===========================================================================
-- E. Helper function: Update timestamp trigger
-- ===========================================================================

-- Function to auto-update updated_at on row modification
CREATE OR REPLACE FUNCTION public.anticipatory_guidance_update_timestamp()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

-- Trigger for updated_at
DROP TRIGGER IF EXISTS trg_anticipatory_guidance_updated_at ON public.anticipatory_guidance;
CREATE TRIGGER trg_anticipatory_guidance_updated_at
    BEFORE UPDATE ON public.anticipatory_guidance
    FOR EACH ROW
    EXECUTE FUNCTION public.anticipatory_guidance_update_timestamp();

-- ===========================================================================
-- F. Comments for documentation
-- ===========================================================================

COMMENT ON TABLE public.anticipatory_guidance IS 'VTID-01146/VTID-01140 D46: Anticipatory guidance items generated from predictive windows (D45) to help users prepare before risk/opportunity windows occur.';

COMMENT ON COLUMN public.anticipatory_guidance.id IS 'Unique identifier for the guidance item';
COMMENT ON COLUMN public.anticipatory_guidance.tenant_id IS 'Tenant isolation identifier';
COMMENT ON COLUMN public.anticipatory_guidance.user_id IS 'Target user for this guidance';
COMMENT ON COLUMN public.anticipatory_guidance.source_window_id IS 'Reference to D45 predictive window that triggered this guidance';
COMMENT ON COLUMN public.anticipatory_guidance.guidance_mode IS 'Mode of guidance: awareness, reflection, preparation, or reinforcement';
COMMENT ON COLUMN public.anticipatory_guidance.domain IS 'Signal domain: health, behavior, social, cognitive, routine, emotional, financial';
COMMENT ON COLUMN public.anticipatory_guidance.confidence IS 'Confidence score 0-100 for this guidance';
COMMENT ON COLUMN public.anticipatory_guidance.timing_hint IS 'When to surface: now, next_24h, or before_window';
COMMENT ON COLUMN public.anticipatory_guidance.guidance_text IS 'The actual guidance text shown to user (optional phrasing, non-directive)';
COMMENT ON COLUMN public.anticipatory_guidance.why_this_matters IS 'Explanation of why this guidance is relevant';
COMMENT ON COLUMN public.anticipatory_guidance.dismissible IS 'Whether user can dismiss this guidance';
COMMENT ON COLUMN public.anticipatory_guidance.originating_signal_ids IS 'Array of D44 signal IDs that contributed to this guidance';
COMMENT ON COLUMN public.anticipatory_guidance.user_preferences_snapshot IS 'Snapshot of user preferences at generation time';
COMMENT ON COLUMN public.anticipatory_guidance.status IS 'Lifecycle status: pending, surfaced, engaged, dismissed, expired';
COMMENT ON COLUMN public.anticipatory_guidance.relevance_score IS 'Computed relevance score 0-100';
COMMENT ON COLUMN public.anticipatory_guidance.generation_rules_version IS 'Version of generation rules used';
COMMENT ON COLUMN public.anticipatory_guidance.metadata IS 'Extensible metadata JSONB';
