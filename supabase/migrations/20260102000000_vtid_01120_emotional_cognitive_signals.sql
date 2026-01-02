-- Migration: 20260102000000_vtid_01120_emotional_cognitive_signals.sql
-- Purpose: VTID-01120 Emotional & Cognitive Signal Interpretation Engine (D28)
-- Date: 2026-01-02
--
-- Creates the deterministic Emotional & Cognitive Signal Engine that interprets
-- how the user is feeling and thinking right now - without guessing, diagnosing,
-- or overreaching. Signals are probabilistic, never asserted as facts.
--
-- Dependencies:
--   - VTID-01101 (Phase A-Fix) - tenant/user/role helpers
--   - VTID-01102 (Phase B-Fix) - runtime context bridge
--   - VTID-01104 (Memory Core v1) - memory_items table
--   - VTID-01082 (Memory Garden + Diary) - memory_diary_entries
--   - VTID-01083 (Longevity Signals) - D26 state input
--
-- Hard Constraints (from spec):
--   - NO medical or psychological diagnosis
--   - NO permanent emotional labeling
--   - NO autonomy escalation from signals alone
--   - Signals only modulate tone, pacing, and depth

-- ===========================================================================
-- 1. emotional_cognitive_signals (Computed signal bundles per turn/session)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.emotional_cognitive_signals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    session_id UUID NULL, -- Optional: link to conversation session
    turn_id UUID NULL,    -- Optional: link to specific conversation turn

    -- Emotional State Signals (0-100 scores with confidence)
    emotional_states JSONB NOT NULL DEFAULT '[]'::JSONB,
    -- Format: [{ "state": "calm|stressed|frustrated|motivated|anxious|neutral",
    --            "score": 0-100, "confidence": 0-100, "decay_at": timestamp }]

    -- Cognitive State Signals (0-100 scores with confidence)
    cognitive_states JSONB NOT NULL DEFAULT '[]'::JSONB,
    -- Format: [{ "state": "focused|overloaded|fatigued|engaged|distracted|neutral",
    --            "score": 0-100, "confidence": 0-100, "decay_at": timestamp }]

    -- Engagement Level (aggregated)
    engagement_level TEXT NOT NULL DEFAULT 'medium'
        CHECK (engagement_level IN ('high', 'medium', 'low')),
    engagement_confidence INT NOT NULL DEFAULT 50
        CHECK (engagement_confidence >= 0 AND engagement_confidence <= 100),

    -- Urgency Signal
    urgency_detected BOOLEAN NOT NULL DEFAULT false,
    urgency_confidence INT NOT NULL DEFAULT 0
        CHECK (urgency_confidence >= 0 AND urgency_confidence <= 100),

    -- Hesitation/Uncertainty Signal
    hesitation_detected BOOLEAN NOT NULL DEFAULT false,
    hesitation_confidence INT NOT NULL DEFAULT 0
        CHECK (hesitation_confidence >= 0 AND hesitation_confidence <= 100),

    -- Evidence trail for explainability
    evidence JSONB NOT NULL DEFAULT '{}'::JSONB,
    -- Format: { "language_patterns": [], "pacing_signals": [],
    --           "correction_signals": [], "time_context": {}, "longevity_state": {} }

    -- Rules that fired
    rules_applied TEXT[] DEFAULT '{}',

    -- Non-clinical disclaimer (always present)
    disclaimer TEXT NOT NULL DEFAULT 'These signals are probabilistic behavioral observations, not clinical assessments.',

    -- Decay management
    decayed BOOLEAN NOT NULL DEFAULT false,
    decay_at TIMESTAMPTZ NULL,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Unique constraint per session/turn
    CONSTRAINT emotional_cognitive_signals_unique
        UNIQUE NULLS NOT DISTINCT (tenant_id, user_id, session_id, turn_id)
);

-- Index for efficient session/turn lookups
CREATE INDEX IF NOT EXISTS idx_emotional_cognitive_signals_session
    ON public.emotional_cognitive_signals (tenant_id, user_id, session_id, created_at DESC);

-- Index for non-decayed signals
CREATE INDEX IF NOT EXISTS idx_emotional_cognitive_signals_active
    ON public.emotional_cognitive_signals (tenant_id, user_id, decayed, created_at DESC)
    WHERE decayed = false;

-- ===========================================================================
-- 2. emotional_cognitive_rules (Deterministic rule registry)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.emotional_cognitive_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_key TEXT NOT NULL UNIQUE,
    rule_version INT NOT NULL DEFAULT 1,
    domain TEXT NOT NULL
        CHECK (domain IN ('emotional', 'cognitive', 'engagement', 'urgency', 'hesitation')),
    target_state TEXT NOT NULL,
    logic JSONB NOT NULL,
    -- Format: { "type": "keyword_match|pattern_match|pacing_check|time_context|longevity_state",
    --           "patterns": [], "keywords": [], "conditions": {},
    --           "effect": "increase|decrease", "delta": 0-100 }
    weight INT NOT NULL DEFAULT 50 CHECK (weight >= 0 AND weight <= 100),
    decay_minutes INT NOT NULL DEFAULT 30, -- How quickly this signal decays
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for active rules lookup
CREATE INDEX IF NOT EXISTS idx_emotional_cognitive_rules_domain_active
    ON public.emotional_cognitive_rules (domain, active);

-- ===========================================================================
-- 3. Seed Default Rules (v1 baseline)
-- ===========================================================================

INSERT INTO public.emotional_cognitive_rules (rule_key, rule_version, domain, target_state, logic, weight, decay_minutes, active) VALUES
    -- =======================================================================
    -- EMOTIONAL STATE RULES
    -- =======================================================================

    -- Calm detection
    ('emotional.v1.calm_keywords', 1, 'emotional', 'calm',
     '{"type": "keyword_match", "keywords": ["thanks", "great", "perfect", "wonderful", "appreciate", "relaxed", "good", "nice"], "effect": "increase", "delta": 20}'::JSONB,
     70, 45, true),
    ('emotional.v1.calm_punctuation', 1, 'emotional', 'calm',
     '{"type": "pattern_match", "patterns": ["^[^!?]{10,}[.]$", "^[a-z]"], "description": "Ends with period, lowercase start suggests calm", "effect": "increase", "delta": 15}'::JSONB,
     60, 30, true),

    -- Stressed detection
    ('emotional.v1.stressed_keywords', 1, 'emotional', 'stressed',
     '{"type": "keyword_match", "keywords": ["stressed", "anxious", "worried", "overwhelmed", "panicking", "nervous", "scared", "afraid", "deadline", "urgent", "asap", "help me"], "effect": "increase", "delta": 25}'::JSONB,
     80, 30, true),
    ('emotional.v1.stressed_punctuation', 1, 'emotional', 'stressed',
     '{"type": "pattern_match", "patterns": ["!{2,}", "\\?{2,}", "!!!"], "description": "Multiple exclamation or question marks suggest stress", "effect": "increase", "delta": 20}'::JSONB,
     70, 20, true),

    -- Frustrated detection
    ('emotional.v1.frustrated_keywords', 1, 'emotional', 'frustrated',
     '{"type": "keyword_match", "keywords": ["frustrated", "annoyed", "angry", "irritated", "fed up", "sick of", "tired of", "hate", "ugh", "argh", "seriously", "again", "still not", "doesn''t work", "broken"], "effect": "increase", "delta": 25}'::JSONB,
     80, 25, true),
    ('emotional.v1.frustrated_corrections', 1, 'emotional', 'frustrated',
     '{"type": "correction_frequency", "threshold": 2, "window_minutes": 5, "description": "Multiple corrections in short window suggest frustration", "effect": "increase", "delta": 20}'::JSONB,
     75, 20, true),
    ('emotional.v1.frustrated_caps', 1, 'emotional', 'frustrated',
     '{"type": "pattern_match", "patterns": ["[A-Z]{3,}"], "description": "ALL CAPS words suggest frustration", "effect": "increase", "delta": 15}'::JSONB,
     65, 15, true),

    -- Motivated detection
    ('emotional.v1.motivated_keywords', 1, 'emotional', 'motivated',
     '{"type": "keyword_match", "keywords": ["excited", "can''t wait", "ready", "let''s do", "let''s go", "motivated", "pumped", "eager", "looking forward", "finally", "awesome"], "effect": "increase", "delta": 25}'::JSONB,
     75, 45, true),
    ('emotional.v1.motivated_engagement', 1, 'emotional', 'motivated',
     '{"type": "pacing_check", "condition": "rapid_responses", "threshold_seconds": 30, "consecutive": 3, "description": "Quick consecutive responses suggest motivation", "effect": "increase", "delta": 15}'::JSONB,
     60, 30, true),

    -- =======================================================================
    -- COGNITIVE STATE RULES
    -- =======================================================================

    -- Focused detection
    ('cognitive.v1.focused_length', 1, 'cognitive', 'focused',
     '{"type": "pattern_match", "patterns": ["^.{50,}$"], "description": "Longer, detailed messages suggest focus", "effect": "increase", "delta": 20}'::JSONB,
     65, 45, true),
    ('cognitive.v1.focused_structure', 1, 'cognitive', 'focused',
     '{"type": "pattern_match", "patterns": ["\\d+\\.", "^-\\s", "^\\*\\s", "first.*second.*third", "step\\s*\\d"], "description": "Structured/numbered content suggests focus", "effect": "increase", "delta": 25}'::JSONB,
     75, 45, true),

    -- Overloaded detection
    ('cognitive.v1.overloaded_keywords', 1, 'cognitive', 'overloaded',
     '{"type": "keyword_match", "keywords": ["too much", "overwhelmed", "confused", "lost", "don''t understand", "complicated", "complex", "slow down", "wait", "hold on", "one thing at a time"], "effect": "increase", "delta": 30}'::JSONB,
     85, 20, true),
    ('cognitive.v1.overloaded_short', 1, 'cognitive', 'overloaded',
     '{"type": "pattern_match", "patterns": ["^.{1,15}$", "^(what|huh|wait|um|uh)[?]?$"], "description": "Very short confused responses suggest overload", "effect": "increase", "delta": 20}'::JSONB,
     70, 15, true),

    -- Fatigued detection
    ('cognitive.v1.fatigued_keywords', 1, 'cognitive', 'fatigued',
     '{"type": "keyword_match", "keywords": ["tired", "exhausted", "sleepy", "drained", "can''t think", "brain fog", "later", "tomorrow", "another time"], "effect": "increase", "delta": 25}'::JSONB,
     75, 60, true),
    ('cognitive.v1.fatigued_time', 1, 'cognitive', 'fatigued',
     '{"type": "time_context", "condition": "late_night", "hours": [23, 0, 1, 2, 3, 4], "description": "Late night interactions suggest potential fatigue", "effect": "increase", "delta": 15}'::JSONB,
     50, 60, true),
    ('cognitive.v1.fatigued_pacing', 1, 'cognitive', 'fatigued',
     '{"type": "pacing_check", "condition": "slow_responses", "threshold_seconds": 120, "consecutive": 2, "description": "Slow response pattern suggests fatigue", "effect": "increase", "delta": 15}'::JSONB,
     55, 45, true),

    -- =======================================================================
    -- ENGAGEMENT LEVEL RULES
    -- =======================================================================

    ('engagement.v1.high_length', 1, 'engagement', 'high',
     '{"type": "pattern_match", "patterns": ["^.{100,}$"], "description": "Long detailed messages suggest high engagement", "effect": "increase", "delta": 25}'::JSONB,
     75, 30, true),
    ('engagement.v1.high_questions', 1, 'engagement', 'high',
     '{"type": "pattern_match", "patterns": ["\\?.*\\?", "can you.*\\?", "how.*\\?", "what.*\\?", "why.*\\?"], "description": "Multiple questions suggest high engagement", "effect": "increase", "delta": 20}'::JSONB,
     70, 30, true),
    ('engagement.v1.low_minimal', 1, 'engagement', 'low',
     '{"type": "pattern_match", "patterns": ["^(ok|okay|k|yes|no|sure|fine|yeah|yep|nope|mhm)[\\.!]?$"], "description": "Minimal responses suggest low engagement", "effect": "increase", "delta": 30}'::JSONB,
     80, 20, true),
    ('engagement.v1.low_pacing', 1, 'engagement', 'low',
     '{"type": "pacing_check", "condition": "very_slow_responses", "threshold_seconds": 300, "description": "Very slow responses suggest low engagement", "effect": "increase", "delta": 20}'::JSONB,
     65, 30, true),

    -- =======================================================================
    -- URGENCY RULES
    -- =======================================================================

    ('urgency.v1.keywords', 1, 'urgency', 'detected',
     '{"type": "keyword_match", "keywords": ["urgent", "asap", "immediately", "right now", "emergency", "critical", "deadline", "today", "now", "hurry", "quick", "fast"], "effect": "increase", "delta": 35}'::JSONB,
     85, 15, true),
    ('urgency.v1.time_pressure', 1, 'urgency', 'detected',
     '{"type": "keyword_match", "keywords": ["in 5 minutes", "in an hour", "by end of day", "before", "due", "meeting", "presentation", "call"], "effect": "increase", "delta": 25}'::JSONB,
     75, 20, true),

    -- =======================================================================
    -- HESITATION RULES
    -- =======================================================================

    ('hesitation.v1.keywords', 1, 'hesitation', 'detected',
     '{"type": "keyword_match", "keywords": ["not sure", "maybe", "perhaps", "i think", "i guess", "probably", "might", "could be", "possibly", "uncertain", "don''t know"], "effect": "increase", "delta": 25}'::JSONB,
     75, 30, true),
    ('hesitation.v1.ellipsis', 1, 'hesitation', 'detected',
     '{"type": "pattern_match", "patterns": ["\\.{3,}", "\\.\\.\\.", "\\?$.*\\?$"], "description": "Trailing ellipsis or multiple questions suggest hesitation", "effect": "increase", "delta": 20}'::JSONB,
     65, 25, true),
    ('hesitation.v1.corrections', 1, 'hesitation', 'detected',
     '{"type": "keyword_match", "keywords": ["actually", "wait", "no i mean", "sorry", "let me rephrase", "what i meant"], "effect": "increase", "delta": 20}'::JSONB,
     70, 20, true),

    -- =======================================================================
    -- LONGEVITY STATE INTEGRATION (D26 -> D28 bridge)
    -- =======================================================================

    ('emotional.v1.longevity_stress_high', 1, 'emotional', 'stressed',
     '{"type": "longevity_state", "signal": "stress_level", "condition": "above", "threshold": 70, "description": "High stress from D26 longevity signals", "effect": "increase", "delta": 15}'::JSONB,
     60, 60, true),
    ('cognitive.v1.longevity_sleep_low', 1, 'cognitive', 'fatigued',
     '{"type": "longevity_state", "signal": "sleep_quality", "condition": "below", "threshold": 40, "description": "Poor sleep from D26 longevity signals suggests fatigue", "effect": "increase", "delta": 20}'::JSONB,
     65, 120, true),
    ('emotional.v1.longevity_social_low', 1, 'emotional', 'stressed',
     '{"type": "longevity_state", "signal": "social_score", "condition": "below", "threshold": 30, "description": "Low social score may indicate isolation stress", "effect": "increase", "delta": 10}'::JSONB,
     50, 60, true)

ON CONFLICT (rule_key) DO NOTHING;

-- ===========================================================================
-- 4. Enable RLS on emotional-cognitive tables
-- ===========================================================================

ALTER TABLE public.emotional_cognitive_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.emotional_cognitive_rules ENABLE ROW LEVEL SECURITY;

-- emotional_cognitive_signals RLS
DROP POLICY IF EXISTS emotional_cognitive_signals_select ON public.emotional_cognitive_signals;
CREATE POLICY emotional_cognitive_signals_select ON public.emotional_cognitive_signals
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS emotional_cognitive_signals_insert ON public.emotional_cognitive_signals;
CREATE POLICY emotional_cognitive_signals_insert ON public.emotional_cognitive_signals
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS emotional_cognitive_signals_update ON public.emotional_cognitive_signals;
CREATE POLICY emotional_cognitive_signals_update ON public.emotional_cognitive_signals
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid())
    WITH CHECK (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

-- emotional_cognitive_rules: read-only for authenticated users
DROP POLICY IF EXISTS emotional_cognitive_rules_select ON public.emotional_cognitive_rules;
CREATE POLICY emotional_cognitive_rules_select ON public.emotional_cognitive_rules
    FOR SELECT TO authenticated
    USING (true);

-- ===========================================================================
-- 5. RPC: emotional_cognitive_compute(p_message text, p_session_id uuid, ...)
-- Deterministic computation of emotional/cognitive signals from message input
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.emotional_cognitive_compute(
    p_message TEXT,
    p_session_id UUID DEFAULT NULL,
    p_turn_id UUID DEFAULT NULL,
    p_response_time_seconds INT DEFAULT NULL,
    p_correction_count INT DEFAULT 0,
    p_interaction_count INT DEFAULT 1
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_message_lower TEXT;
    v_current_hour INT;

    -- Score accumulators (start at 0, will be normalized)
    v_emotional_scores JSONB := '{}'::JSONB;
    v_cognitive_scores JSONB := '{}'::JSONB;
    v_engagement_high INT := 0;
    v_engagement_low INT := 0;
    v_urgency_score INT := 0;
    v_hesitation_score INT := 0;

    -- Confidence trackers
    v_emotional_confidence JSONB := '{}'::JSONB;
    v_cognitive_confidence JSONB := '{}'::JSONB;

    -- Evidence accumulator
    v_evidence JSONB := '{
        "language_patterns": [],
        "pacing_signals": [],
        "correction_signals": [],
        "time_context": {},
        "longevity_state": {}
    }'::JSONB;

    v_rules_applied TEXT[] := '{}';
    v_rule RECORD;
    v_matched BOOLEAN;
    v_delta INT;
    v_decay_minutes INT;
    v_match_detail JSONB;
    v_longevity_signals RECORD;

    -- Output builders
    v_emotional_states JSONB := '[]'::JSONB;
    v_cognitive_states JSONB := '[]'::JSONB;
    v_engagement_level TEXT := 'medium';
    v_engagement_confidence INT := 50;
    v_decay_at TIMESTAMPTZ;
BEGIN
    -- Gate 1: Get tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TENANT_NOT_FOUND',
            'message', 'Unable to determine tenant_id from request context'
        );
    END IF;

    -- Gate 2: Get user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Prepare message for analysis
    v_message_lower := LOWER(COALESCE(p_message, ''));
    v_current_hour := EXTRACT(HOUR FROM NOW())::INT;

    -- ===========================================================================
    -- Fetch D26 Longevity State (if available)
    -- ===========================================================================
    SELECT sleep_quality, stress_level, social_score
    INTO v_longevity_signals
    FROM public.longevity_signals_daily
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND signal_date = CURRENT_DATE
    LIMIT 1;

    IF v_longevity_signals IS NOT NULL THEN
        v_evidence := jsonb_set(
            v_evidence,
            '{longevity_state}',
            jsonb_build_object(
                'sleep_quality', v_longevity_signals.sleep_quality,
                'stress_level', v_longevity_signals.stress_level,
                'social_score', v_longevity_signals.social_score,
                'source', 'D26_longevity_signals_daily'
            )
        );
    END IF;

    -- Add time context to evidence
    v_evidence := jsonb_set(
        v_evidence,
        '{time_context}',
        jsonb_build_object(
            'current_hour', v_current_hour,
            'is_late_night', v_current_hour >= 23 OR v_current_hour <= 4,
            'response_time_seconds', p_response_time_seconds,
            'correction_count', p_correction_count,
            'interaction_count', p_interaction_count
        )
    );

    -- ===========================================================================
    -- Apply Rules to Message
    -- ===========================================================================
    FOR v_rule IN
        SELECT * FROM public.emotional_cognitive_rules
        WHERE active = true
        ORDER BY weight DESC
    LOOP
        v_matched := false;
        v_delta := COALESCE((v_rule.logic->>'delta')::INT, 10);
        v_decay_minutes := v_rule.decay_minutes;

        -- Keyword match rule
        IF (v_rule.logic->>'type') = 'keyword_match' THEN
            DECLARE
                v_keyword TEXT;
                v_matched_keywords TEXT[] := '{}';
            BEGIN
                FOR v_keyword IN
                    SELECT jsonb_array_elements_text(v_rule.logic->'keywords')
                LOOP
                    IF v_message_lower LIKE '%' || LOWER(v_keyword) || '%' THEN
                        v_matched := true;
                        v_matched_keywords := array_append(v_matched_keywords, v_keyword);
                    END IF;
                END LOOP;

                IF v_matched THEN
                    v_match_detail := jsonb_build_object(
                        'rule', v_rule.rule_key,
                        'type', 'keyword_match',
                        'matched_keywords', to_jsonb(v_matched_keywords)
                    );
                    v_evidence := jsonb_set(
                        v_evidence,
                        '{language_patterns}',
                        COALESCE(v_evidence->'language_patterns', '[]'::JSONB) || v_match_detail
                    );
                END IF;
            END;
        END IF;

        -- Pattern match rule (regex-based)
        IF (v_rule.logic->>'type') = 'pattern_match' THEN
            DECLARE
                v_pattern TEXT;
                v_matched_patterns TEXT[] := '{}';
            BEGIN
                FOR v_pattern IN
                    SELECT jsonb_array_elements_text(v_rule.logic->'patterns')
                LOOP
                    BEGIN
                        IF p_message ~* v_pattern THEN
                            v_matched := true;
                            v_matched_patterns := array_append(v_matched_patterns, v_pattern);
                        END IF;
                    EXCEPTION WHEN OTHERS THEN
                        -- Invalid regex, skip
                        NULL;
                    END;
                END LOOP;

                IF v_matched THEN
                    v_match_detail := jsonb_build_object(
                        'rule', v_rule.rule_key,
                        'type', 'pattern_match',
                        'matched_patterns', to_jsonb(v_matched_patterns),
                        'description', v_rule.logic->>'description'
                    );
                    v_evidence := jsonb_set(
                        v_evidence,
                        '{language_patterns}',
                        COALESCE(v_evidence->'language_patterns', '[]'::JSONB) || v_match_detail
                    );
                END IF;
            END;
        END IF;

        -- Time context rule
        IF (v_rule.logic->>'type') = 'time_context' THEN
            IF (v_rule.logic->>'condition') = 'late_night' THEN
                IF v_current_hour = ANY(ARRAY(SELECT (jsonb_array_elements_text(v_rule.logic->'hours'))::INT)) THEN
                    v_matched := true;
                    v_match_detail := jsonb_build_object(
                        'rule', v_rule.rule_key,
                        'type', 'time_context',
                        'current_hour', v_current_hour,
                        'description', v_rule.logic->>'description'
                    );
                    v_evidence := jsonb_set(
                        v_evidence,
                        '{time_context,matched_rules}',
                        COALESCE(v_evidence->'time_context'->'matched_rules', '[]'::JSONB) || v_match_detail
                    );
                END IF;
            END IF;
        END IF;

        -- Pacing check rule
        IF (v_rule.logic->>'type') = 'pacing_check' AND p_response_time_seconds IS NOT NULL THEN
            DECLARE
                v_threshold INT := COALESCE((v_rule.logic->>'threshold_seconds')::INT, 60);
            BEGIN
                IF (v_rule.logic->>'condition') = 'rapid_responses' THEN
                    IF p_response_time_seconds < v_threshold THEN
                        v_matched := true;
                    END IF;
                ELSIF (v_rule.logic->>'condition') = 'slow_responses' THEN
                    IF p_response_time_seconds > v_threshold THEN
                        v_matched := true;
                    END IF;
                ELSIF (v_rule.logic->>'condition') = 'very_slow_responses' THEN
                    IF p_response_time_seconds > v_threshold THEN
                        v_matched := true;
                    END IF;
                END IF;

                IF v_matched THEN
                    v_match_detail := jsonb_build_object(
                        'rule', v_rule.rule_key,
                        'type', 'pacing_check',
                        'response_time_seconds', p_response_time_seconds,
                        'threshold', v_threshold,
                        'description', v_rule.logic->>'description'
                    );
                    v_evidence := jsonb_set(
                        v_evidence,
                        '{pacing_signals}',
                        COALESCE(v_evidence->'pacing_signals', '[]'::JSONB) || v_match_detail
                    );
                END IF;
            END;
        END IF;

        -- Correction frequency rule
        IF (v_rule.logic->>'type') = 'correction_frequency' THEN
            DECLARE
                v_threshold INT := COALESCE((v_rule.logic->>'threshold')::INT, 2);
            BEGIN
                IF p_correction_count >= v_threshold THEN
                    v_matched := true;
                    v_match_detail := jsonb_build_object(
                        'rule', v_rule.rule_key,
                        'type', 'correction_frequency',
                        'correction_count', p_correction_count,
                        'threshold', v_threshold,
                        'description', v_rule.logic->>'description'
                    );
                    v_evidence := jsonb_set(
                        v_evidence,
                        '{correction_signals}',
                        COALESCE(v_evidence->'correction_signals', '[]'::JSONB) || v_match_detail
                    );
                END IF;
            END;
        END IF;

        -- Longevity state rule (D26 integration)
        IF (v_rule.logic->>'type') = 'longevity_state' AND v_longevity_signals IS NOT NULL THEN
            DECLARE
                v_signal_name TEXT := v_rule.logic->>'signal';
                v_condition TEXT := v_rule.logic->>'condition';
                v_threshold INT := COALESCE((v_rule.logic->>'threshold')::INT, 50);
                v_signal_value INT;
            BEGIN
                -- Get the signal value
                CASE v_signal_name
                    WHEN 'stress_level' THEN v_signal_value := v_longevity_signals.stress_level;
                    WHEN 'sleep_quality' THEN v_signal_value := v_longevity_signals.sleep_quality;
                    WHEN 'social_score' THEN v_signal_value := v_longevity_signals.social_score;
                    ELSE v_signal_value := NULL;
                END CASE;

                IF v_signal_value IS NOT NULL THEN
                    IF v_condition = 'above' AND v_signal_value > v_threshold THEN
                        v_matched := true;
                    ELSIF v_condition = 'below' AND v_signal_value < v_threshold THEN
                        v_matched := true;
                    END IF;

                    IF v_matched THEN
                        v_match_detail := jsonb_build_object(
                            'rule', v_rule.rule_key,
                            'type', 'longevity_state',
                            'signal', v_signal_name,
                            'value', v_signal_value,
                            'condition', v_condition,
                            'threshold', v_threshold,
                            'description', v_rule.logic->>'description'
                        );
                        v_evidence := jsonb_set(
                            v_evidence,
                            '{longevity_state,matched_rules}',
                            COALESCE(v_evidence->'longevity_state'->'matched_rules', '[]'::JSONB) || v_match_detail
                        );
                    END IF;
                END IF;
            END;
        END IF;

        -- ===========================================================================
        -- Apply Score Deltas
        -- ===========================================================================
        IF v_matched THEN
            v_rules_applied := array_append(v_rules_applied, v_rule.rule_key);

            CASE v_rule.domain
                WHEN 'emotional' THEN
                    -- Accumulate emotional state scores
                    v_emotional_scores := jsonb_set(
                        v_emotional_scores,
                        ARRAY[v_rule.target_state],
                        to_jsonb(COALESCE((v_emotional_scores->>v_rule.target_state)::INT, 0) + v_delta)
                    );
                    v_emotional_confidence := jsonb_set(
                        v_emotional_confidence,
                        ARRAY[v_rule.target_state],
                        to_jsonb(GREATEST(
                            COALESCE((v_emotional_confidence->>v_rule.target_state)::INT, 0),
                            v_rule.weight
                        ))
                    );

                WHEN 'cognitive' THEN
                    -- Accumulate cognitive state scores
                    v_cognitive_scores := jsonb_set(
                        v_cognitive_scores,
                        ARRAY[v_rule.target_state],
                        to_jsonb(COALESCE((v_cognitive_scores->>v_rule.target_state)::INT, 0) + v_delta)
                    );
                    v_cognitive_confidence := jsonb_set(
                        v_cognitive_confidence,
                        ARRAY[v_rule.target_state],
                        to_jsonb(GREATEST(
                            COALESCE((v_cognitive_confidence->>v_rule.target_state)::INT, 0),
                            v_rule.weight
                        ))
                    );

                WHEN 'engagement' THEN
                    IF v_rule.target_state = 'high' THEN
                        v_engagement_high := v_engagement_high + v_delta;
                    ELSE
                        v_engagement_low := v_engagement_low + v_delta;
                    END IF;

                WHEN 'urgency' THEN
                    v_urgency_score := v_urgency_score + v_delta;

                WHEN 'hesitation' THEN
                    v_hesitation_score := v_hesitation_score + v_delta;
            END CASE;
        END IF;
    END LOOP;

    -- ===========================================================================
    -- Build Output Signal Bundle
    -- ===========================================================================

    -- Calculate decay time (use minimum decay from matched rules, default 30 min)
    v_decay_at := NOW() + INTERVAL '30 minutes';

    -- Build emotional states array with scores and confidence
    DECLARE
        v_state TEXT;
        v_score INT;
        v_conf INT;
    BEGIN
        FOR v_state, v_score IN SELECT * FROM jsonb_each_text(v_emotional_scores) LOOP
            v_conf := COALESCE((v_emotional_confidence->>v_state)::INT, 50);
            v_emotional_states := v_emotional_states || jsonb_build_object(
                'state', v_state,
                'score', LEAST(100, v_score::INT),
                'confidence', v_conf,
                'decay_at', v_decay_at
            );
        END LOOP;
    END;

    -- Build cognitive states array with scores and confidence
    DECLARE
        v_state TEXT;
        v_score INT;
        v_conf INT;
    BEGIN
        FOR v_state, v_score IN SELECT * FROM jsonb_each_text(v_cognitive_scores) LOOP
            v_conf := COALESCE((v_cognitive_confidence->>v_state)::INT, 50);
            v_cognitive_states := v_cognitive_states || jsonb_build_object(
                'state', v_state,
                'score', LEAST(100, v_score::INT),
                'confidence', v_conf,
                'decay_at', v_decay_at
            );
        END LOOP;
    END;

    -- Determine engagement level
    IF v_engagement_high > v_engagement_low + 20 THEN
        v_engagement_level := 'high';
        v_engagement_confidence := LEAST(100, 50 + v_engagement_high);
    ELSIF v_engagement_low > v_engagement_high + 20 THEN
        v_engagement_level := 'low';
        v_engagement_confidence := LEAST(100, 50 + v_engagement_low);
    ELSE
        v_engagement_level := 'medium';
        v_engagement_confidence := 50;
    END IF;

    -- ===========================================================================
    -- Upsert Signal Row
    -- ===========================================================================
    INSERT INTO public.emotional_cognitive_signals (
        tenant_id,
        user_id,
        session_id,
        turn_id,
        emotional_states,
        cognitive_states,
        engagement_level,
        engagement_confidence,
        urgency_detected,
        urgency_confidence,
        hesitation_detected,
        hesitation_confidence,
        evidence,
        rules_applied,
        decay_at
    ) VALUES (
        v_tenant_id,
        v_user_id,
        p_session_id,
        p_turn_id,
        v_emotional_states,
        v_cognitive_states,
        v_engagement_level,
        v_engagement_confidence,
        v_urgency_score >= 25,
        LEAST(100, v_urgency_score + 50),
        v_hesitation_score >= 20,
        LEAST(100, v_hesitation_score + 50),
        v_evidence,
        v_rules_applied,
        v_decay_at
    )
    ON CONFLICT (tenant_id, user_id, session_id, turn_id)
    DO UPDATE SET
        emotional_states = EXCLUDED.emotional_states,
        cognitive_states = EXCLUDED.cognitive_states,
        engagement_level = EXCLUDED.engagement_level,
        engagement_confidence = EXCLUDED.engagement_confidence,
        urgency_detected = EXCLUDED.urgency_detected,
        urgency_confidence = EXCLUDED.urgency_confidence,
        hesitation_detected = EXCLUDED.hesitation_detected,
        hesitation_confidence = EXCLUDED.hesitation_confidence,
        evidence = EXCLUDED.evidence,
        rules_applied = EXCLUDED.rules_applied,
        decay_at = EXCLUDED.decay_at,
        updated_at = NOW();

    -- Return signal bundle
    RETURN jsonb_build_object(
        'ok', true,
        'signal_bundle', jsonb_build_object(
            'emotional_states', v_emotional_states,
            'cognitive_states', v_cognitive_states,
            'engagement_level', v_engagement_level,
            'engagement_confidence', v_engagement_confidence,
            'urgency', jsonb_build_object(
                'detected', v_urgency_score >= 25,
                'confidence', LEAST(100, v_urgency_score + 50)
            ),
            'hesitation', jsonb_build_object(
                'detected', v_hesitation_score >= 20,
                'confidence', LEAST(100, v_hesitation_score + 50)
            ),
            'decay_at', v_decay_at,
            'disclaimer', 'These signals are probabilistic behavioral observations, not clinical assessments.'
        ),
        'evidence', v_evidence,
        'rules_applied', to_jsonb(v_rules_applied),
        'tenant_id', v_tenant_id,
        'user_id', v_user_id,
        'session_id', p_session_id,
        'turn_id', p_turn_id
    );
END;
$$;

-- ===========================================================================
-- 6. RPC: emotional_cognitive_get_current(p_session_id uuid)
-- Get current (non-decayed) signals for a session
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.emotional_cognitive_get_current(
    p_session_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_signal RECORD;
    v_signals JSONB := '[]'::JSONB;
BEGIN
    -- Gate 1: Get tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TENANT_NOT_FOUND',
            'message', 'Unable to determine tenant_id from request context'
        );
    END IF;

    -- Gate 2: Get user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Mark decayed signals
    UPDATE public.emotional_cognitive_signals
    SET decayed = true, updated_at = NOW()
    WHERE tenant_id = v_tenant_id
      AND user_id = v_user_id
      AND decayed = false
      AND decay_at < NOW();

    -- Fetch current signals
    FOR v_signal IN
        SELECT *
        FROM public.emotional_cognitive_signals
        WHERE tenant_id = v_tenant_id
          AND user_id = v_user_id
          AND decayed = false
          AND (p_session_id IS NULL OR session_id = p_session_id)
        ORDER BY created_at DESC
        LIMIT 5
    LOOP
        v_signals := v_signals || jsonb_build_object(
            'id', v_signal.id,
            'session_id', v_signal.session_id,
            'turn_id', v_signal.turn_id,
            'emotional_states', v_signal.emotional_states,
            'cognitive_states', v_signal.cognitive_states,
            'engagement_level', v_signal.engagement_level,
            'engagement_confidence', v_signal.engagement_confidence,
            'urgency', jsonb_build_object(
                'detected', v_signal.urgency_detected,
                'confidence', v_signal.urgency_confidence
            ),
            'hesitation', jsonb_build_object(
                'detected', v_signal.hesitation_detected,
                'confidence', v_signal.hesitation_confidence
            ),
            'decay_at', v_signal.decay_at,
            'created_at', v_signal.created_at,
            'disclaimer', v_signal.disclaimer
        );
    END LOOP;

    RETURN jsonb_build_object(
        'ok', true,
        'signals', v_signals,
        'count', jsonb_array_length(v_signals),
        'session_id', p_session_id
    );
END;
$$;

-- ===========================================================================
-- 7. RPC: emotional_cognitive_override(p_signal_id uuid, p_override jsonb)
-- User correction immediately overrides signals (spec requirement)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.emotional_cognitive_override(
    p_signal_id UUID,
    p_override JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_signal RECORD;
BEGIN
    -- Gate 1: Get tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TENANT_NOT_FOUND',
            'message', 'Unable to determine tenant_id from request context'
        );
    END IF;

    -- Gate 2: Get user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Get the signal to override
    SELECT * INTO v_signal
    FROM public.emotional_cognitive_signals
    WHERE id = p_signal_id
      AND tenant_id = v_tenant_id
      AND user_id = v_user_id;

    IF v_signal IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'SIGNAL_NOT_FOUND',
            'message', 'Signal not found or not authorized'
        );
    END IF;

    -- Apply override - immediately decay the signal and record correction
    UPDATE public.emotional_cognitive_signals
    SET
        decayed = true,
        evidence = v_signal.evidence || jsonb_build_object(
            'user_override', jsonb_build_object(
                'applied_at', NOW(),
                'override_data', p_override,
                'reason', 'User correction immediately overrides signals per spec'
            )
        ),
        updated_at = NOW()
    WHERE id = p_signal_id;

    RETURN jsonb_build_object(
        'ok', true,
        'message', 'Signal overridden by user correction',
        'signal_id', p_signal_id,
        'override', p_override
    );
END;
$$;

-- ===========================================================================
-- 8. RPC: emotional_cognitive_explain(p_signal_id uuid)
-- Returns detailed evidence for explainability (D59 support)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.emotional_cognitive_explain(
    p_signal_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_signal RECORD;
    v_rules JSONB;
BEGIN
    -- Gate 1: Get tenant_id from context
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TENANT_NOT_FOUND',
            'message', 'Unable to determine tenant_id from request context'
        );
    END IF;

    -- Gate 2: Get user_id from auth
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    -- Get the signal
    SELECT * INTO v_signal
    FROM public.emotional_cognitive_signals
    WHERE id = p_signal_id
      AND tenant_id = v_tenant_id
      AND user_id = v_user_id;

    IF v_signal IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'SIGNAL_NOT_FOUND',
            'message', 'Signal not found or not authorized'
        );
    END IF;

    -- Get rules that were applied
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'rule_key', rule_key,
                'rule_version', rule_version,
                'domain', domain,
                'target_state', target_state,
                'logic', logic,
                'weight', weight,
                'decay_minutes', decay_minutes
            )
        ),
        '[]'::JSONB
    )
    INTO v_rules
    FROM public.emotional_cognitive_rules
    WHERE rule_key = ANY(v_signal.rules_applied);

    RETURN jsonb_build_object(
        'ok', true,
        'signal_id', p_signal_id,
        'signal_bundle', jsonb_build_object(
            'emotional_states', v_signal.emotional_states,
            'cognitive_states', v_signal.cognitive_states,
            'engagement_level', v_signal.engagement_level,
            'engagement_confidence', v_signal.engagement_confidence,
            'urgency', jsonb_build_object(
                'detected', v_signal.urgency_detected,
                'confidence', v_signal.urgency_confidence
            ),
            'hesitation', jsonb_build_object(
                'detected', v_signal.hesitation_detected,
                'confidence', v_signal.hesitation_confidence
            )
        ),
        'evidence', v_signal.evidence,
        'rules_applied', v_rules,
        'rules_applied_keys', to_jsonb(v_signal.rules_applied),
        'decay_at', v_signal.decay_at,
        'decayed', v_signal.decayed,
        'created_at', v_signal.created_at,
        'disclaimer', v_signal.disclaimer
    );
END;
$$;

-- ===========================================================================
-- 9. Permissions
-- ===========================================================================

-- Grant execute on RPCs to authenticated users
GRANT EXECUTE ON FUNCTION public.emotional_cognitive_compute(TEXT, UUID, UUID, INT, INT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.emotional_cognitive_get_current(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.emotional_cognitive_override(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.emotional_cognitive_explain(UUID) TO authenticated;

-- Grant table access (RLS enforces row-level security)
GRANT SELECT ON public.emotional_cognitive_signals TO authenticated;
GRANT SELECT ON public.emotional_cognitive_rules TO authenticated;

-- ===========================================================================
-- 10. Comments
-- ===========================================================================

COMMENT ON TABLE public.emotional_cognitive_signals IS 'VTID-01120: Computed emotional & cognitive signals per session/turn. Probabilistic, never diagnostic.';
COMMENT ON TABLE public.emotional_cognitive_rules IS 'VTID-01120: Deterministic rule registry for emotional/cognitive signal computation.';

COMMENT ON FUNCTION public.emotional_cognitive_compute IS 'VTID-01120: Compute emotional & cognitive signals from message input. Deterministic, rule-based only.';
COMMENT ON FUNCTION public.emotional_cognitive_get_current IS 'VTID-01120: Get current (non-decayed) signals for a user/session.';
COMMENT ON FUNCTION public.emotional_cognitive_override IS 'VTID-01120: User correction immediately overrides signals.';
COMMENT ON FUNCTION public.emotional_cognitive_explain IS 'VTID-01120: Get detailed evidence for explainability (D59 support).';
