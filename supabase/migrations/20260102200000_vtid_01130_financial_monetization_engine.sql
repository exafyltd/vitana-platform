-- Migration: 20260102200000_vtid_01130_financial_monetization_engine.sql
-- Purpose: VTID-01130 D36 - Financial Sensitivity, Monetization Readiness & Value Perception Engine
-- Date: 2026-01-02
--
-- Understands whether, when, and how money should enter the conversation
-- without damaging trust, comfort, or perceived value.
--
-- Core Question: "Is this the right moment to suggest something paid — and in what form?"
--
-- Hard Constraints (Non-Negotiable):
--   - Never lead with price — always lead with value
--   - Never stack multiple paid suggestions
--   - No monetization when emotional vulnerability is detected
--   - Explicit user "no" blocks monetization immediately
--   - Zero social pressure allowed
--
-- Dependencies:
--   - VTID-01101 (Phase A-Fix) - tenant/user/role helpers
--   - VTID-01121 (D29) - Trust & Feedback Loops
--   - VTID-01120 (D28) - Emotional & Cognitive Signals
--   - VTID-01119 (D27) - User Preference & Constraint Modeling

-- ===========================================================================
-- 1. MONETIZATION SIGNALS TABLE
-- ===========================================================================
-- Records financial sensitivity signals from user behavior
-- Used to infer sensitivity level without explicit income data

CREATE TABLE IF NOT EXISTS public.monetization_signals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    signal_type TEXT NOT NULL CHECK (signal_type IN (
        'paid_suggestion_accepted',
        'paid_suggestion_rejected',
        'paid_suggestion_deferred',
        'free_alternative_preference',
        'budget_language_detected',
        'price_inquiry',
        'value_question',
        'payment_completed',
        'payment_abandoned',
        'subscription_interest',
        'one_time_preference'
    )),
    indicator TEXT NOT NULL DEFAULT 'neutral' CHECK (indicator IN ('positive', 'negative', 'neutral')),
    weight INT NOT NULL DEFAULT 50 CHECK (weight >= 0 AND weight <= 100),
    context TEXT NULL,
    session_id TEXT NULL,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_monetization_signals_tenant_user
    ON public.monetization_signals (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_monetization_signals_detected
    ON public.monetization_signals (tenant_id, user_id, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_monetization_signals_type
    ON public.monetization_signals (tenant_id, user_id, signal_type);

CREATE INDEX IF NOT EXISTS idx_monetization_signals_session
    ON public.monetization_signals (session_id) WHERE session_id IS NOT NULL;

-- ===========================================================================
-- 2. VALUE SIGNALS TABLE
-- ===========================================================================
-- Records value perception signals from user behavior
-- Used to model how users perceive value (outcome/experience/efficiency/price)

CREATE TABLE IF NOT EXISTS public.value_signals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    signal_type TEXT NOT NULL CHECK (signal_type IN (
        'asked_about_results',
        'asked_about_experience',
        'asked_about_time',
        'asked_about_price',
        'mentioned_past_outcome',
        'mentioned_enjoyment',
        'mentioned_time_saved',
        'compared_prices'
    )),
    driver TEXT NOT NULL CHECK (driver IN ('outcome', 'experience', 'efficiency', 'price')),
    strength INT NOT NULL DEFAULT 50 CHECK (strength >= 0 AND strength <= 100),
    context TEXT NULL,
    session_id TEXT NULL,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_value_signals_tenant_user
    ON public.value_signals (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_value_signals_detected
    ON public.value_signals (tenant_id, user_id, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_value_signals_driver
    ON public.value_signals (tenant_id, user_id, driver);

-- ===========================================================================
-- 3. MONETIZATION ATTEMPTS TABLE
-- ===========================================================================
-- Records all monetization attempts and their outcomes
-- Used for history analysis and cooldown management

CREATE TABLE IF NOT EXISTS public.monetization_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    attempt_type TEXT NOT NULL CHECK (attempt_type IN (
        'product',
        'service',
        'session',
        'subscription',
        'upgrade',
        'donation'
    )),
    outcome TEXT NOT NULL CHECK (outcome IN (
        'accepted',
        'rejected',
        'deferred',
        'ignored',
        'converted_free',
        'abandoned'
    )),
    readiness_score_at_attempt NUMERIC(3,2) NOT NULL DEFAULT 0.0 CHECK (readiness_score_at_attempt >= 0 AND readiness_score_at_attempt <= 1),
    envelope_at_attempt JSONB NULL,
    user_response TEXT NULL,
    session_id TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_monetization_attempts_tenant_user
    ON public.monetization_attempts (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_monetization_attempts_created
    ON public.monetization_attempts (tenant_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_monetization_attempts_outcome
    ON public.monetization_attempts (tenant_id, user_id, outcome);

CREATE INDEX IF NOT EXISTS idx_monetization_attempts_session
    ON public.monetization_attempts (session_id) WHERE session_id IS NOT NULL;

-- ===========================================================================
-- 4. MONETIZATION COOLDOWNS TABLE
-- ===========================================================================
-- Tracks active cooldown periods after rejections or negative signals

CREATE TABLE IF NOT EXISTS public.monetization_cooldowns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    cooldown_type TEXT NOT NULL CHECK (cooldown_type IN (
        'rejection',
        'emotional_vulnerability',
        'session_limit',
        'explicit_refusal',
        'trust_repair'
    )),
    reason TEXT NULL,
    triggered_by_attempt_id UUID NULL REFERENCES public.monetization_attempts(id),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_monetization_cooldowns_active
    ON public.monetization_cooldowns (tenant_id, user_id, is_active)
    WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_monetization_cooldowns_expires
    ON public.monetization_cooldowns (expires_at)
    WHERE is_active = TRUE;

-- ===========================================================================
-- 5. VALUE PROFILES TABLE (Cached Aggregates)
-- ===========================================================================
-- Cached value perception profiles computed from signals

CREATE TABLE IF NOT EXISTS public.value_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    outcome_focus INT NOT NULL DEFAULT 25 CHECK (outcome_focus >= 0 AND outcome_focus <= 100),
    experience_focus INT NOT NULL DEFAULT 25 CHECK (experience_focus >= 0 AND experience_focus <= 100),
    efficiency_focus INT NOT NULL DEFAULT 25 CHECK (efficiency_focus >= 0 AND efficiency_focus <= 100),
    price_sensitivity INT NOT NULL DEFAULT 25 CHECK (price_sensitivity >= 0 AND price_sensitivity <= 100),
    primary_driver TEXT NOT NULL DEFAULT 'outcome' CHECK (primary_driver IN ('outcome', 'experience', 'efficiency', 'price')),
    confidence INT NOT NULL DEFAULT 30 CHECK (confidence >= 0 AND confidence <= 100),
    signal_count INT NOT NULL DEFAULT 0,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, user_id)
);

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_value_profiles_tenant_user
    ON public.value_profiles (tenant_id, user_id);

-- ===========================================================================
-- 6. FINANCIAL SENSITIVITY CACHE TABLE
-- ===========================================================================
-- Cached financial sensitivity levels

CREATE TABLE IF NOT EXISTS public.financial_sensitivity_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    sensitivity_level TEXT NOT NULL DEFAULT 'unknown' CHECK (sensitivity_level IN ('high', 'medium', 'low', 'unknown')),
    confidence INT NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 100),
    signal_count INT NOT NULL DEFAULT 0,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '12 hours'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, user_id)
);

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_financial_sensitivity_tenant_user
    ON public.financial_sensitivity_cache (tenant_id, user_id);

-- ===========================================================================
-- 7. MONETIZATION AUDIT LOG
-- ===========================================================================
-- Audit log for all monetization decisions and events

CREATE TABLE IF NOT EXISTS public.monetization_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN (
        'context_computed',
        'envelope_generated',
        'signal_recorded',
        'attempt_recorded',
        'cooldown_triggered',
        'cooldown_expired',
        'gating_blocked',
        'gating_passed'
    )),
    event_data JSONB NOT NULL DEFAULT '{}'::JSONB,
    session_id TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_monetization_audit_tenant_user
    ON public.monetization_audit (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_monetization_audit_created
    ON public.monetization_audit (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_monetization_audit_type
    ON public.monetization_audit (event_type, created_at DESC);

-- ===========================================================================
-- 8. ROW LEVEL SECURITY
-- ===========================================================================

-- Enable RLS on all tables
ALTER TABLE public.monetization_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.value_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monetization_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monetization_cooldowns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.value_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_sensitivity_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monetization_audit ENABLE ROW LEVEL SECURITY;

-- monetization_signals: User owns their signals
DROP POLICY IF EXISTS monetization_signals_select ON public.monetization_signals;
CREATE POLICY monetization_signals_select ON public.monetization_signals
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS monetization_signals_insert ON public.monetization_signals;
CREATE POLICY monetization_signals_insert ON public.monetization_signals
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- value_signals: User owns their signals
DROP POLICY IF EXISTS value_signals_select ON public.value_signals;
CREATE POLICY value_signals_select ON public.value_signals
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS value_signals_insert ON public.value_signals;
CREATE POLICY value_signals_insert ON public.value_signals
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- monetization_attempts: User owns their attempts
DROP POLICY IF EXISTS monetization_attempts_select ON public.monetization_attempts;
CREATE POLICY monetization_attempts_select ON public.monetization_attempts
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS monetization_attempts_insert ON public.monetization_attempts;
CREATE POLICY monetization_attempts_insert ON public.monetization_attempts
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- monetization_cooldowns: User owns their cooldowns
DROP POLICY IF EXISTS monetization_cooldowns_select ON public.monetization_cooldowns;
CREATE POLICY monetization_cooldowns_select ON public.monetization_cooldowns
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS monetization_cooldowns_insert ON public.monetization_cooldowns;
CREATE POLICY monetization_cooldowns_insert ON public.monetization_cooldowns
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS monetization_cooldowns_update ON public.monetization_cooldowns;
CREATE POLICY monetization_cooldowns_update ON public.monetization_cooldowns
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

-- value_profiles: User owns their profile
DROP POLICY IF EXISTS value_profiles_select ON public.value_profiles;
CREATE POLICY value_profiles_select ON public.value_profiles
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS value_profiles_insert ON public.value_profiles;
CREATE POLICY value_profiles_insert ON public.value_profiles
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS value_profiles_update ON public.value_profiles;
CREATE POLICY value_profiles_update ON public.value_profiles
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

-- financial_sensitivity_cache: User owns their cache
DROP POLICY IF EXISTS financial_sensitivity_cache_select ON public.financial_sensitivity_cache;
CREATE POLICY financial_sensitivity_cache_select ON public.financial_sensitivity_cache
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS financial_sensitivity_cache_insert ON public.financial_sensitivity_cache;
CREATE POLICY financial_sensitivity_cache_insert ON public.financial_sensitivity_cache
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS financial_sensitivity_cache_update ON public.financial_sensitivity_cache;
CREATE POLICY financial_sensitivity_cache_update ON public.financial_sensitivity_cache
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

-- monetization_audit: User can view their audit history
DROP POLICY IF EXISTS monetization_audit_select ON public.monetization_audit;
CREATE POLICY monetization_audit_select ON public.monetization_audit
    FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

DROP POLICY IF EXISTS monetization_audit_insert ON public.monetization_audit;
CREATE POLICY monetization_audit_insert ON public.monetization_audit
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = auth.uid()
    );

-- ===========================================================================
-- 9. RPC FUNCTIONS
-- ===========================================================================

-- 9.1 monetization_record_signal - Record a financial or value signal
CREATE OR REPLACE FUNCTION public.monetization_record_signal(
    p_signal_type TEXT,
    p_indicator TEXT DEFAULT 'neutral',
    p_weight INT DEFAULT 50,
    p_context TEXT DEFAULT NULL,
    p_session_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_signal_id UUID;
    v_is_financial BOOLEAN;
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

    -- Validate indicator
    IF p_indicator NOT IN ('positive', 'negative', 'neutral') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_INDICATOR',
            'message', 'Indicator must be positive, negative, or neutral'
        );
    END IF;

    -- Check if financial signal
    v_is_financial := p_signal_type IN (
        'paid_suggestion_accepted', 'paid_suggestion_rejected', 'paid_suggestion_deferred',
        'free_alternative_preference', 'budget_language_detected', 'price_inquiry',
        'value_question', 'payment_completed', 'payment_abandoned',
        'subscription_interest', 'one_time_preference'
    );

    IF v_is_financial THEN
        -- Insert financial signal
        INSERT INTO public.monetization_signals (
            tenant_id, user_id, signal_type, indicator, weight, context, session_id
        ) VALUES (
            v_tenant_id, v_user_id, p_signal_type, p_indicator, p_weight, p_context, p_session_id
        )
        RETURNING id INTO v_signal_id;
    ELSE
        -- Check if value signal
        IF p_signal_type NOT IN (
            'asked_about_results', 'asked_about_experience', 'asked_about_time',
            'asked_about_price', 'mentioned_past_outcome', 'mentioned_enjoyment',
            'mentioned_time_saved', 'compared_prices'
        ) THEN
            RETURN jsonb_build_object(
                'ok', false,
                'error', 'INVALID_SIGNAL_TYPE',
                'message', 'Unknown signal type'
            );
        END IF;

        -- Determine driver
        DECLARE
            v_driver TEXT;
        BEGIN
            v_driver := CASE
                WHEN p_signal_type IN ('asked_about_results', 'mentioned_past_outcome') THEN 'outcome'
                WHEN p_signal_type IN ('asked_about_experience', 'mentioned_enjoyment') THEN 'experience'
                WHEN p_signal_type IN ('asked_about_time', 'mentioned_time_saved') THEN 'efficiency'
                ELSE 'price'
            END;

            INSERT INTO public.value_signals (
                tenant_id, user_id, signal_type, driver, strength, context, session_id
            ) VALUES (
                v_tenant_id, v_user_id, p_signal_type, v_driver, p_weight, p_context, p_session_id
            )
            RETURNING id INTO v_signal_id;
        END;
    END IF;

    -- Write audit log
    INSERT INTO public.monetization_audit (
        tenant_id, user_id, event_type, event_data, session_id
    ) VALUES (
        v_tenant_id, v_user_id, 'signal_recorded',
        jsonb_build_object(
            'signal_id', v_signal_id,
            'signal_type', p_signal_type,
            'indicator', p_indicator,
            'is_financial', v_is_financial
        ),
        p_session_id
    );

    RETURN jsonb_build_object(
        'ok', true,
        'signal_id', v_signal_id,
        'is_financial', v_is_financial
    );
END;
$$;

-- 9.2 monetization_record_attempt - Record a monetization attempt outcome
CREATE OR REPLACE FUNCTION public.monetization_record_attempt(
    p_attempt_type TEXT,
    p_outcome TEXT,
    p_readiness_score NUMERIC DEFAULT 0.0,
    p_envelope JSONB DEFAULT NULL,
    p_user_response TEXT DEFAULT NULL,
    p_session_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_attempt_id UUID;
    v_cooldown_id UUID;
    v_cooldown_triggered BOOLEAN := FALSE;
    v_cooldown_until TIMESTAMPTZ;
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

    -- Validate attempt type
    IF p_attempt_type NOT IN ('product', 'service', 'session', 'subscription', 'upgrade', 'donation') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_ATTEMPT_TYPE',
            'message', 'Invalid attempt type'
        );
    END IF;

    -- Validate outcome
    IF p_outcome NOT IN ('accepted', 'rejected', 'deferred', 'ignored', 'converted_free', 'abandoned') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_OUTCOME',
            'message', 'Invalid outcome'
        );
    END IF;

    -- Insert attempt
    INSERT INTO public.monetization_attempts (
        tenant_id, user_id, attempt_type, outcome, readiness_score_at_attempt,
        envelope_at_attempt, user_response, session_id
    ) VALUES (
        v_tenant_id, v_user_id, p_attempt_type, p_outcome, p_readiness_score,
        p_envelope, p_user_response, p_session_id
    )
    RETURNING id INTO v_attempt_id;

    -- Check if cooldown should be triggered
    IF p_outcome = 'rejected' THEN
        v_cooldown_triggered := TRUE;
        v_cooldown_until := NOW() + INTERVAL '30 minutes';

        INSERT INTO public.monetization_cooldowns (
            tenant_id, user_id, cooldown_type, reason, triggered_by_attempt_id, expires_at
        ) VALUES (
            v_tenant_id, v_user_id, 'rejection', 'User rejected suggestion',
            v_attempt_id, v_cooldown_until
        )
        RETURNING id INTO v_cooldown_id;
    END IF;

    -- Write audit log
    INSERT INTO public.monetization_audit (
        tenant_id, user_id, event_type, event_data, session_id
    ) VALUES (
        v_tenant_id, v_user_id, 'attempt_recorded',
        jsonb_build_object(
            'attempt_id', v_attempt_id,
            'attempt_type', p_attempt_type,
            'outcome', p_outcome,
            'cooldown_triggered', v_cooldown_triggered,
            'cooldown_until', v_cooldown_until
        ),
        p_session_id
    );

    RETURN jsonb_build_object(
        'ok', true,
        'attempt_id', v_attempt_id,
        'cooldown_triggered', v_cooldown_triggered,
        'cooldown_until', v_cooldown_until
    );
END;
$$;

-- 9.3 monetization_get_active_cooldowns - Get active cooldowns for user
CREATE OR REPLACE FUNCTION public.monetization_get_active_cooldowns()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_cooldowns JSONB;
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

    -- Expire old cooldowns first
    UPDATE public.monetization_cooldowns
    SET is_active = FALSE
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND is_active = TRUE
      AND expires_at < NOW();

    -- Get active cooldowns
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', id,
                'type', cooldown_type,
                'reason', reason,
                'expires_at', expires_at,
                'remaining_minutes', EXTRACT(EPOCH FROM (expires_at - NOW())) / 60
            )
        ),
        '[]'::JSONB
    )
    INTO v_cooldowns
    FROM public.monetization_cooldowns
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND is_active = TRUE
      AND expires_at > NOW();

    RETURN jsonb_build_object(
        'ok', true,
        'cooldowns', v_cooldowns,
        'has_active_cooldown', jsonb_array_length(v_cooldowns) > 0
    );
END;
$$;

-- 9.4 monetization_get_history - Get monetization attempt history
CREATE OR REPLACE FUNCTION public.monetization_get_history(
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
    v_attempts JSONB;
    v_total INT;
    v_acceptance_rate NUMERIC;
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
    IF p_limit < 1 THEN p_limit := 20; END IF;
    IF p_limit > 100 THEN p_limit := 100; END IF;
    IF p_offset < 0 THEN p_offset := 0; END IF;

    -- Get total count
    SELECT COUNT(*) INTO v_total
    FROM public.monetization_attempts
    WHERE tenant_id = v_tenant_id AND user_id = v_user_id;

    -- Calculate acceptance rate
    SELECT COALESCE(
        (COUNT(*) FILTER (WHERE outcome = 'accepted'))::NUMERIC /
        NULLIF(COUNT(*)::NUMERIC, 0),
        0
    )
    INTO v_acceptance_rate
    FROM public.monetization_attempts
    WHERE tenant_id = v_tenant_id AND user_id = v_user_id;

    -- Get attempts
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', id,
                'attempt_type', attempt_type,
                'outcome', outcome,
                'readiness_score', readiness_score_at_attempt,
                'user_response', user_response,
                'session_id', session_id,
                'created_at', created_at
            )
            ORDER BY created_at DESC
        ),
        '[]'::JSONB
    )
    INTO v_attempts
    FROM public.monetization_attempts
    WHERE tenant_id = v_tenant_id AND user_id = v_user_id
    ORDER BY created_at DESC
    LIMIT p_limit
    OFFSET p_offset;

    RETURN jsonb_build_object(
        'ok', true,
        'attempts', v_attempts,
        'total_count', v_total,
        'acceptance_rate', ROUND(v_acceptance_rate, 3),
        'pagination', jsonb_build_object(
            'limit', p_limit,
            'offset', p_offset,
            'has_more', (p_offset + p_limit) < v_total
        )
    );
END;
$$;

-- 9.5 monetization_check_gating - Check if monetization is allowed
CREATE OR REPLACE FUNCTION public.monetization_check_gating(
    p_readiness_score NUMERIC DEFAULT 0.5,
    p_trust_score INT DEFAULT 70,
    p_has_emotional_vulnerability BOOLEAN DEFAULT FALSE,
    p_session_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_checks JSONB := '[]'::JSONB;
    v_passed BOOLEAN := TRUE;
    v_blocking_check TEXT := NULL;
    v_has_cooldown BOOLEAN;
    v_session_attempt_count INT;
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

    -- Check 1: Readiness threshold
    IF p_readiness_score < 0.6 THEN
        v_passed := FALSE;
        v_blocking_check := 'readiness_threshold';
        v_checks := v_checks || jsonb_build_object(
            'check_type', 'readiness_threshold',
            'passed', FALSE,
            'threshold', 0.6,
            'actual_value', p_readiness_score,
            'reason', 'Readiness score below threshold'
        );
    ELSE
        v_checks := v_checks || jsonb_build_object(
            'check_type', 'readiness_threshold',
            'passed', TRUE,
            'threshold', 0.6,
            'actual_value', p_readiness_score
        );
    END IF;

    -- Check 2: Trust positive
    IF p_trust_score < 40 THEN
        IF v_passed THEN
            v_passed := FALSE;
            v_blocking_check := 'trust_positive';
        END IF;
        v_checks := v_checks || jsonb_build_object(
            'check_type', 'trust_positive',
            'passed', FALSE,
            'threshold', 40,
            'actual_value', p_trust_score,
            'reason', 'Trust score too low'
        );
    ELSE
        v_checks := v_checks || jsonb_build_object(
            'check_type', 'trust_positive',
            'passed', TRUE,
            'threshold', 40,
            'actual_value', p_trust_score
        );
    END IF;

    -- Check 3: No emotional vulnerability
    IF p_has_emotional_vulnerability THEN
        IF v_passed THEN
            v_passed := FALSE;
            v_blocking_check := 'no_emotional_vulnerability';
        END IF;
        v_checks := v_checks || jsonb_build_object(
            'check_type', 'no_emotional_vulnerability',
            'passed', FALSE,
            'reason', 'User shows emotional vulnerability'
        );
    ELSE
        v_checks := v_checks || jsonb_build_object(
            'check_type', 'no_emotional_vulnerability',
            'passed', TRUE
        );
    END IF;

    -- Check 4: Cooldown clear
    SELECT EXISTS(
        SELECT 1 FROM public.monetization_cooldowns
        WHERE tenant_id = v_tenant_id
          AND user_id = v_user_id
          AND is_active = TRUE
          AND expires_at > NOW()
    ) INTO v_has_cooldown;

    IF v_has_cooldown THEN
        IF v_passed THEN
            v_passed := FALSE;
            v_blocking_check := 'cooldown_clear';
        END IF;
        v_checks := v_checks || jsonb_build_object(
            'check_type', 'cooldown_clear',
            'passed', FALSE,
            'reason', 'Monetization cooldown is active'
        );
    ELSE
        v_checks := v_checks || jsonb_build_object(
            'check_type', 'cooldown_clear',
            'passed', TRUE
        );
    END IF;

    -- Check 5: Session limit
    IF p_session_id IS NOT NULL THEN
        SELECT COUNT(*) INTO v_session_attempt_count
        FROM public.monetization_attempts
        WHERE tenant_id = v_tenant_id
          AND user_id = v_user_id
          AND session_id = p_session_id
          AND outcome != 'accepted';

        IF v_session_attempt_count >= 2 THEN
            IF v_passed THEN
                v_passed := FALSE;
                v_blocking_check := 'session_limit';
            END IF;
            v_checks := v_checks || jsonb_build_object(
                'check_type', 'session_limit',
                'passed', FALSE,
                'threshold', 2,
                'actual_value', v_session_attempt_count,
                'reason', 'Session attempt limit reached'
            );
        ELSE
            v_checks := v_checks || jsonb_build_object(
                'check_type', 'session_limit',
                'passed', TRUE,
                'threshold', 2,
                'actual_value', v_session_attempt_count
            );
        END IF;
    END IF;

    -- Write audit log
    INSERT INTO public.monetization_audit (
        tenant_id, user_id, event_type, event_data, session_id
    ) VALUES (
        v_tenant_id, v_user_id,
        CASE WHEN v_passed THEN 'gating_passed' ELSE 'gating_blocked' END,
        jsonb_build_object(
            'checks', v_checks,
            'passed', v_passed,
            'blocking_check', v_blocking_check
        ),
        p_session_id
    );

    RETURN jsonb_build_object(
        'ok', true,
        'passed', v_passed,
        'checks', v_checks,
        'blocking_check', v_blocking_check,
        'computed_at', NOW()
    );
END;
$$;

-- ===========================================================================
-- 10. PERMISSIONS
-- ===========================================================================

-- RPC functions: callable by authenticated users
GRANT EXECUTE ON FUNCTION public.monetization_record_signal(TEXT, TEXT, INT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.monetization_record_attempt(TEXT, TEXT, NUMERIC, JSONB, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.monetization_get_active_cooldowns() TO authenticated;
GRANT EXECUTE ON FUNCTION public.monetization_get_history(INT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.monetization_check_gating(NUMERIC, INT, BOOLEAN, TEXT) TO authenticated;

-- Tables: allow authenticated users to interact (RLS enforces row-level access)
GRANT SELECT, INSERT ON public.monetization_signals TO authenticated;
GRANT SELECT, INSERT ON public.value_signals TO authenticated;
GRANT SELECT, INSERT ON public.monetization_attempts TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.monetization_cooldowns TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.value_profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.financial_sensitivity_cache TO authenticated;
GRANT SELECT, INSERT ON public.monetization_audit TO authenticated;

-- ===========================================================================
-- 11. COMMENTS
-- ===========================================================================

COMMENT ON TABLE public.monetization_signals IS 'VTID-01130 D36: Financial sensitivity signals from user behavior';
COMMENT ON TABLE public.value_signals IS 'VTID-01130 D36: Value perception signals (outcome/experience/efficiency/price)';
COMMENT ON TABLE public.monetization_attempts IS 'VTID-01130 D36: Monetization attempt history and outcomes';
COMMENT ON TABLE public.monetization_cooldowns IS 'VTID-01130 D36: Active cooldown periods after rejections';
COMMENT ON TABLE public.value_profiles IS 'VTID-01130 D36: Cached value perception profiles';
COMMENT ON TABLE public.financial_sensitivity_cache IS 'VTID-01130 D36: Cached financial sensitivity levels';
COMMENT ON TABLE public.monetization_audit IS 'VTID-01130 D36: Audit log for all monetization decisions';

COMMENT ON FUNCTION public.monetization_record_signal IS 'VTID-01130 D36: Record a financial or value signal';
COMMENT ON FUNCTION public.monetization_record_attempt IS 'VTID-01130 D36: Record a monetization attempt outcome';
COMMENT ON FUNCTION public.monetization_get_active_cooldowns IS 'VTID-01130 D36: Get active cooldowns for user';
COMMENT ON FUNCTION public.monetization_get_history IS 'VTID-01130 D36: Get monetization attempt history';
COMMENT ON FUNCTION public.monetization_check_gating IS 'VTID-01130 D36: Check if monetization is allowed (gating)';
