-- Migration: 20251231000001_vtid_01089_autopilot_prompts.sql
-- Purpose: VTID-01089 Autopilot Matchmaking Prompts (One-Tap Consent + Rate Limits + Opt-out)
-- Date: 2025-12-31
--
-- This migration establishes the autopilot prompts system for matchmaking:
--   - autopilot_prompt_prefs: User preferences for autopilot prompts (opt-out, rate limits, quiet hours)
--   - autopilot_prompts: Actual prompts generated from matches_daily
--
-- The prompts system:
--   - Generates prompts from high-score matches (matches_daily)
--   - Enforces user-configured rate limits (max prompts per day)
--   - Respects quiet hours (e.g., 22:00-08:00)
--   - Allows type filtering (person, group, event, service)
--   - Tracks prompt state (shown, accepted, dismissed, expired)
--
-- Depends on: VTID-01088 (matches_daily table - reference only, no FK constraint yet)

-- ===========================================================================
-- 1. AUTOPILOT_PROMPT_PREFS TABLE
-- ===========================================================================
-- User preferences for autopilot prompts - controls rate limits, quiet hours, opt-out

CREATE TABLE IF NOT EXISTS public.autopilot_prompt_prefs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.app_users(user_id) ON DELETE CASCADE,

    -- Opt-out toggle: if false, no prompts are generated for this user
    enabled BOOLEAN NOT NULL DEFAULT true,

    -- Rate limit: maximum prompts per day (hard cap enforced server-side)
    max_prompts_per_day INTEGER NOT NULL DEFAULT 5 CHECK (max_prompts_per_day >= 0 AND max_prompts_per_day <= 50),

    -- Quiet hours: time window when prompts are NOT shown (e.g., {"from":"22:00","to":"08:00"})
    quiet_hours JSONB DEFAULT NULL,

    -- Allowed match types: which types of matches can generate prompts
    -- Values: person, group, event, service, product, location
    allow_types TEXT[] DEFAULT ARRAY['person', 'group', 'event', 'service'],

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Unique constraint: one preference row per user per tenant
    CONSTRAINT autopilot_prompt_prefs_tenant_user_unique UNIQUE (tenant_id, user_id)
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_autopilot_prompt_prefs_tenant ON public.autopilot_prompt_prefs (tenant_id);
CREATE INDEX IF NOT EXISTS idx_autopilot_prompt_prefs_user ON public.autopilot_prompt_prefs (user_id);
CREATE INDEX IF NOT EXISTS idx_autopilot_prompt_prefs_enabled ON public.autopilot_prompt_prefs (enabled) WHERE enabled = true;

-- Enable RLS with strict tenant isolation
ALTER TABLE public.autopilot_prompt_prefs ENABLE ROW LEVEL SECURITY;

-- Users can read their own preferences within their tenant
DROP POLICY IF EXISTS autopilot_prompt_prefs_select_own ON public.autopilot_prompt_prefs;
CREATE POLICY autopilot_prompt_prefs_select_own ON public.autopilot_prompt_prefs
    FOR SELECT TO authenticated
    USING (user_id = auth.uid() OR user_id = public.current_user_id());

-- Users can update their own preferences
DROP POLICY IF EXISTS autopilot_prompt_prefs_update_own ON public.autopilot_prompt_prefs;
CREATE POLICY autopilot_prompt_prefs_update_own ON public.autopilot_prompt_prefs
    FOR UPDATE TO authenticated
    USING (user_id = auth.uid() OR user_id = public.current_user_id());

-- Users can insert their own preferences
DROP POLICY IF EXISTS autopilot_prompt_prefs_insert_own ON public.autopilot_prompt_prefs;
CREATE POLICY autopilot_prompt_prefs_insert_own ON public.autopilot_prompt_prefs
    FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid() OR user_id = public.current_user_id());

-- Service role can do all operations
DROP POLICY IF EXISTS autopilot_prompt_prefs_all_service_role ON public.autopilot_prompt_prefs;
CREATE POLICY autopilot_prompt_prefs_all_service_role ON public.autopilot_prompt_prefs
    FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.autopilot_prompt_prefs IS 'VTID-01089: User preferences for autopilot matchmaking prompts (rate limits, quiet hours, opt-out)';
COMMENT ON COLUMN public.autopilot_prompt_prefs.enabled IS 'If false, no prompts are generated for this user';
COMMENT ON COLUMN public.autopilot_prompt_prefs.max_prompts_per_day IS 'Maximum prompts per day (hard cap, 0-50)';
COMMENT ON COLUMN public.autopilot_prompt_prefs.quiet_hours IS 'Time window when prompts are suppressed: {"from":"HH:MM","to":"HH:MM"}';
COMMENT ON COLUMN public.autopilot_prompt_prefs.allow_types IS 'Match types that can generate prompts: person, group, event, service, product, location';

-- ===========================================================================
-- 2. AUTOPILOT_PROMPTS TABLE
-- ===========================================================================
-- Actual prompts generated from matches_daily - tracks state and actions

CREATE TABLE IF NOT EXISTS public.autopilot_prompts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.app_users(user_id) ON DELETE CASCADE,

    -- Date when this prompt was generated (for daily rate limiting)
    prompt_date DATE NOT NULL DEFAULT CURRENT_DATE,

    -- Type of prompt (currently only match_suggestion)
    prompt_type TEXT NOT NULL DEFAULT 'match_suggestion' CHECK (prompt_type IN ('match_suggestion', 'recommendation', 'reminder')),

    -- Reference to the match that generated this prompt
    -- Note: FK to matches_daily deferred until VTID-01088 is implemented
    match_id UUID,

    -- Match type (person, group, event, service, product, location)
    match_type TEXT CHECK (match_type IN ('person', 'group', 'event', 'service', 'product', 'location')),

    -- Content
    title TEXT NOT NULL,
    message TEXT NOT NULL,

    -- Actions available (JSON array of action objects)
    -- Default: [{"key":"yes","label":"Yes"},{"key":"not_now","label":"Not now"},{"key":"options","label":"See options"}]
    actions JSONB NOT NULL DEFAULT '[{"key":"yes","label":"Yes"},{"key":"not_now","label":"Not now"},{"key":"options","label":"See options"}]'::jsonb,

    -- Prompt state machine: shown → accepted|dismissed|expired
    state TEXT NOT NULL DEFAULT 'shown' CHECK (state IN ('shown', 'accepted', 'dismissed', 'expired')),

    -- Action taken (if state is accepted or dismissed)
    action_taken TEXT CHECK (action_taken IN ('yes', 'not_now', 'options')),

    -- Target entity reference (the entity being suggested)
    target_id UUID,
    target_type TEXT CHECK (target_type IN ('person', 'group', 'event', 'service', 'product', 'location')),
    target_title TEXT,

    -- Topic/reason for match (e.g., "wellness", "fitness", "nutrition")
    topic TEXT,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    shown_at TIMESTAMPTZ,
    actioned_at TIMESTAMPTZ,

    -- Composite index for daily rate limiting
    CONSTRAINT autopilot_prompts_unique_match UNIQUE (tenant_id, user_id, match_id)
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_autopilot_prompts_tenant ON public.autopilot_prompts (tenant_id);
CREATE INDEX IF NOT EXISTS idx_autopilot_prompts_user ON public.autopilot_prompts (user_id);
CREATE INDEX IF NOT EXISTS idx_autopilot_prompts_date ON public.autopilot_prompts (prompt_date);
CREATE INDEX IF NOT EXISTS idx_autopilot_prompts_state ON public.autopilot_prompts (state);
CREATE INDEX IF NOT EXISTS idx_autopilot_prompts_user_date ON public.autopilot_prompts (user_id, prompt_date);

-- Composite index for "today's prompts for user" query pattern
CREATE INDEX IF NOT EXISTS idx_autopilot_prompts_user_date_state ON public.autopilot_prompts (tenant_id, user_id, prompt_date, state);

-- Enable RLS with strict tenant isolation
ALTER TABLE public.autopilot_prompts ENABLE ROW LEVEL SECURITY;

-- Users can read their own prompts
DROP POLICY IF EXISTS autopilot_prompts_select_own ON public.autopilot_prompts;
CREATE POLICY autopilot_prompts_select_own ON public.autopilot_prompts
    FOR SELECT TO authenticated
    USING (user_id = auth.uid() OR user_id = public.current_user_id());

-- Users can update their own prompts (for state changes)
DROP POLICY IF EXISTS autopilot_prompts_update_own ON public.autopilot_prompts;
CREATE POLICY autopilot_prompts_update_own ON public.autopilot_prompts
    FOR UPDATE TO authenticated
    USING (user_id = auth.uid() OR user_id = public.current_user_id());

-- Service role can do all operations
DROP POLICY IF EXISTS autopilot_prompts_all_service_role ON public.autopilot_prompts;
CREATE POLICY autopilot_prompts_all_service_role ON public.autopilot_prompts
    FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.autopilot_prompts IS 'VTID-01089: Autopilot prompts generated from matches_daily for matchmaking';
COMMENT ON COLUMN public.autopilot_prompts.prompt_date IS 'Date when prompt was generated (for daily rate limit counting)';
COMMENT ON COLUMN public.autopilot_prompts.match_id IS 'Reference to matches_daily.id (FK deferred until VTID-01088)';
COMMENT ON COLUMN public.autopilot_prompts.state IS 'Prompt state: shown, accepted, dismissed, expired';
COMMENT ON COLUMN public.autopilot_prompts.actions IS 'Available actions: [{"key":"yes"},{"key":"not_now"},{"key":"options"}]';

-- ===========================================================================
-- 3. HELPER FUNCTION: count_prompts_today
-- ===========================================================================
-- Returns the count of prompts shown to a user today (for rate limiting)

CREATE OR REPLACE FUNCTION public.count_prompts_today(
    p_tenant_id UUID,
    p_user_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count INTEGER;
BEGIN
    SELECT COUNT(*)::INTEGER INTO v_count
    FROM public.autopilot_prompts
    WHERE tenant_id = p_tenant_id
      AND user_id = p_user_id
      AND prompt_date = CURRENT_DATE;

    RETURN COALESCE(v_count, 0);
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION public.count_prompts_today(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.count_prompts_today(UUID, UUID) TO service_role;

COMMENT ON FUNCTION public.count_prompts_today IS 'VTID-01089: Count prompts shown to user today (for rate limiting)';

-- ===========================================================================
-- 4. HELPER FUNCTION: is_in_quiet_hours
-- ===========================================================================
-- Checks if current time is within quiet hours for a user

CREATE OR REPLACE FUNCTION public.is_in_quiet_hours(
    p_quiet_hours JSONB,
    p_current_time TIME DEFAULT LOCALTIME
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_from_time TIME;
    v_to_time TIME;
BEGIN
    -- No quiet hours configured
    IF p_quiet_hours IS NULL OR p_quiet_hours = 'null'::jsonb THEN
        RETURN false;
    END IF;

    -- Parse from/to times
    v_from_time := (p_quiet_hours->>'from')::TIME;
    v_to_time := (p_quiet_hours->>'to')::TIME;

    -- Handle NULL cases
    IF v_from_time IS NULL OR v_to_time IS NULL THEN
        RETURN false;
    END IF;

    -- Handle overnight quiet hours (e.g., 22:00 to 08:00)
    IF v_from_time > v_to_time THEN
        -- Overnight: quiet if current >= from OR current < to
        RETURN p_current_time >= v_from_time OR p_current_time < v_to_time;
    ELSE
        -- Same day: quiet if current >= from AND current < to
        RETURN p_current_time >= v_from_time AND p_current_time < v_to_time;
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_in_quiet_hours(JSONB, TIME) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_in_quiet_hours(JSONB, TIME) TO service_role;

COMMENT ON FUNCTION public.is_in_quiet_hours IS 'VTID-01089: Check if current time is within quiet hours window';

-- ===========================================================================
-- 5. HELPER FUNCTION: get_user_prompt_prefs
-- ===========================================================================
-- Returns user prompt preferences, creating default if not exists

CREATE OR REPLACE FUNCTION public.get_user_prompt_prefs(
    p_tenant_id UUID,
    p_user_id UUID
)
RETURNS TABLE (
    id UUID,
    enabled BOOLEAN,
    max_prompts_per_day INTEGER,
    quiet_hours JSONB,
    allow_types TEXT[],
    prompts_today INTEGER,
    in_quiet_hours BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_prefs RECORD;
BEGIN
    -- Get or create preferences
    SELECT * INTO v_prefs
    FROM public.autopilot_prompt_prefs pp
    WHERE pp.tenant_id = p_tenant_id AND pp.user_id = p_user_id;

    -- If no prefs exist, return defaults
    IF NOT FOUND THEN
        RETURN QUERY SELECT
            NULL::UUID as id,
            true::BOOLEAN as enabled,
            5::INTEGER as max_prompts_per_day,
            NULL::JSONB as quiet_hours,
            ARRAY['person', 'group', 'event', 'service']::TEXT[] as allow_types,
            public.count_prompts_today(p_tenant_id, p_user_id) as prompts_today,
            false::BOOLEAN as in_quiet_hours;
        RETURN;
    END IF;

    -- Return existing preferences with computed fields
    RETURN QUERY SELECT
        v_prefs.id,
        v_prefs.enabled,
        v_prefs.max_prompts_per_day,
        v_prefs.quiet_hours,
        v_prefs.allow_types,
        public.count_prompts_today(p_tenant_id, p_user_id) as prompts_today,
        public.is_in_quiet_hours(v_prefs.quiet_hours) as in_quiet_hours;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_user_prompt_prefs(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_prompt_prefs(UUID, UUID) TO service_role;

COMMENT ON FUNCTION public.get_user_prompt_prefs IS 'VTID-01089: Get user prompt preferences with computed fields';

-- ===========================================================================
-- 6. VERIFICATION QUERIES
-- ===========================================================================

-- 6.1 Verify tables exist
DO $$
DECLARE
    v_prefs_exists BOOLEAN;
    v_prompts_exists BOOLEAN;
BEGIN
    SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'autopilot_prompt_prefs') INTO v_prefs_exists;
    SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'autopilot_prompts') INTO v_prompts_exists;

    IF v_prefs_exists AND v_prompts_exists THEN
        RAISE NOTICE 'VERIFY OK: Both autopilot_prompt_prefs and autopilot_prompts tables exist';
    ELSE
        RAISE WARNING 'VERIFY FAIL: Missing tables. prefs=%, prompts=%', v_prefs_exists, v_prompts_exists;
    END IF;
END $$;

-- 6.2 Verify functions exist
DO $$
DECLARE
    v_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname IN ('count_prompts_today', 'is_in_quiet_hours', 'get_user_prompt_prefs');

    IF v_count = 3 THEN
        RAISE NOTICE 'VERIFY OK: All 3 helper functions exist';
    ELSE
        RAISE WARNING 'VERIFY FAIL: Expected 3 functions, found %', v_count;
    END IF;
END $$;

-- 6.3 Verify RLS is enabled
DO $$
DECLARE
    v_prefs_rls BOOLEAN;
    v_prompts_rls BOOLEAN;
BEGIN
    SELECT relrowsecurity INTO v_prefs_rls FROM pg_class WHERE relname = 'autopilot_prompt_prefs';
    SELECT relrowsecurity INTO v_prompts_rls FROM pg_class WHERE relname = 'autopilot_prompts';

    IF v_prefs_rls AND v_prompts_rls THEN
        RAISE NOTICE 'VERIFY OK: RLS enabled on both tables';
    ELSE
        RAISE WARNING 'VERIFY FAIL: RLS not enabled. prefs=%, prompts=%', v_prefs_rls, v_prompts_rls;
    END IF;
END $$;

-- ===========================================================================
-- Migration Complete: VTID-01089 Autopilot Matchmaking Prompts
-- ===========================================================================
