-- Migration: 20260102_vtid_01121_feedback_trust_repair.sql
-- Purpose: VTID-01121 User Feedback, Correction & Trust Repair Engine
-- Date: 2026-01-02
--
-- This migration creates tables for the deterministic feedback and correction loop
-- that allows ORB to accept corrections, repair trust, and permanently improve behavior.
--
-- Core principle: Intelligence that cannot be corrected becomes dangerous.
-- User feedback is first-class input and authoritative.

-- ===========================================================================
-- VTID-01121: Feedback Corrections Table
-- ===========================================================================
-- Stores all user feedback events with affected components and applied changes.
-- Feedback types: explicit_correction, preference_clarification, boundary_enforcement,
--                 tone_adjustment, suggestion_rejection, autonomy_refusal

CREATE TABLE IF NOT EXISTS feedback_corrections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,

    -- Feedback classification
    feedback_type TEXT NOT NULL CHECK (feedback_type IN (
        'explicit_correction',
        'preference_clarification',
        'boundary_enforcement',
        'tone_adjustment',
        'suggestion_rejection',
        'autonomy_refusal'
    )),

    -- What was corrected
    correction_target TEXT NOT NULL, -- e.g., 'memory', 'preference', 'behavior', 'recommendation'
    correction_detail TEXT NOT NULL, -- User's correction text/description

    -- Affected components (for propagation)
    affected_memory_ids UUID[] DEFAULT '{}',
    affected_rule_ids UUID[] DEFAULT '{}',
    affected_state_keys TEXT[] DEFAULT '{}',

    -- Applied changes (deterministic record)
    changes_applied JSONB NOT NULL DEFAULT '{}',
    -- Example: { "confidence_before": 0.85, "confidence_after": 0.40, "constraint_added": "never_suggest_X" }

    -- Trust impact
    trust_impact_score INT NOT NULL DEFAULT 0, -- Negative = trust decrease, Positive = trust recovery

    -- Safety flags (for medical/emotional corrections)
    safety_escalation BOOLEAN NOT NULL DEFAULT FALSE,
    safety_category TEXT DEFAULT NULL, -- 'medical', 'emotional', 'sensitive', null

    -- Propagation tracking
    propagated BOOLEAN NOT NULL DEFAULT FALSE,
    propagated_at TIMESTAMPTZ DEFAULT NULL,
    propagation_log JSONB DEFAULT NULL, -- Record of which layers received the correction

    -- Audit
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    session_id TEXT DEFAULT NULL, -- ORB session where correction occurred
    context_snapshot JSONB DEFAULT NULL -- Relevant context at time of correction (non-sensitive)
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_feedback_corrections_tenant_id ON feedback_corrections(tenant_id);
CREATE INDEX IF NOT EXISTS idx_feedback_corrections_user_id ON feedback_corrections(user_id);
CREATE INDEX IF NOT EXISTS idx_feedback_corrections_type ON feedback_corrections(feedback_type);
CREATE INDEX IF NOT EXISTS idx_feedback_corrections_target ON feedback_corrections(correction_target);
CREATE INDEX IF NOT EXISTS idx_feedback_corrections_created_at ON feedback_corrections(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_corrections_tenant_user ON feedback_corrections(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_feedback_corrections_safety ON feedback_corrections(safety_escalation) WHERE safety_escalation = TRUE;
CREATE INDEX IF NOT EXISTS idx_feedback_corrections_propagated ON feedback_corrections(propagated) WHERE propagated = FALSE;

-- ===========================================================================
-- VTID-01121: Trust Repair Log Table
-- ===========================================================================
-- Tracks trust repair actions and recovery over time.
-- Trust is repaired through acknowledgment, behavior change, and consistency.

CREATE TABLE IF NOT EXISTS trust_repair_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,

    -- Link to original correction
    feedback_correction_id UUID REFERENCES feedback_corrections(id) ON DELETE SET NULL,

    -- Repair action
    repair_action TEXT NOT NULL CHECK (repair_action IN (
        'acknowledged',        -- ORB acknowledged the mistake
        'correction_applied',  -- Correction was applied to system
        'behavior_changed',    -- Behavior demonstrably changed
        'trust_recovering',    -- Trust score increasing
        'trust_restored',      -- Trust fully restored
        'repeated_error',      -- Same error occurred again (negative)
        'constraint_added',    -- New constraint added to prevent recurrence
        'rule_updated'         -- Existing rule was updated
    )),

    -- Trust score tracking
    trust_score_before INT NOT NULL, -- 0-100
    trust_score_after INT NOT NULL,  -- 0-100
    trust_delta INT GENERATED ALWAYS AS (trust_score_after - trust_score_before) STORED,

    -- Details
    repair_details JSONB NOT NULL DEFAULT '{}',
    -- Example: { "acknowledgment": "I understand you prefer X", "constraint": "never_do_Y" }

    -- Audit
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_trust_repair_log_tenant_id ON trust_repair_log(tenant_id);
CREATE INDEX IF NOT EXISTS idx_trust_repair_log_user_id ON trust_repair_log(user_id);
CREATE INDEX IF NOT EXISTS idx_trust_repair_log_correction_id ON trust_repair_log(feedback_correction_id);
CREATE INDEX IF NOT EXISTS idx_trust_repair_log_action ON trust_repair_log(repair_action);
CREATE INDEX IF NOT EXISTS idx_trust_repair_log_created_at ON trust_repair_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trust_repair_log_tenant_user ON trust_repair_log(tenant_id, user_id);

-- ===========================================================================
-- VTID-01121: Behavior Constraints Table
-- ===========================================================================
-- Stores rejected behaviors that may not resurface automatically.
-- These are permanent unless explicitly removed by user.

CREATE TABLE IF NOT EXISTS behavior_constraints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,

    -- Source correction
    feedback_correction_id UUID REFERENCES feedback_corrections(id) ON DELETE CASCADE,

    -- Constraint definition
    constraint_type TEXT NOT NULL CHECK (constraint_type IN (
        'never_suggest',       -- Never suggest this topic/action again
        'always_ask_first',    -- Always ask before doing this
        'confidence_cap',      -- Cap confidence on this topic
        'require_confirmation',-- Require explicit confirmation
        'topic_block',         -- Block entire topic
        'behavior_block',      -- Block specific behavior pattern
        'preference_override'  -- Override inferred preference
    )),

    constraint_key TEXT NOT NULL, -- What the constraint applies to (topic, behavior, etc.)
    constraint_value JSONB NOT NULL DEFAULT '{}',
    -- Example: { "blocked_topic": "investment_advice", "reason": "user_corrected" }

    -- Status
    active BOOLEAN NOT NULL DEFAULT TRUE,
    deactivated_at TIMESTAMPTZ DEFAULT NULL,
    deactivation_reason TEXT DEFAULT NULL,

    -- Audit
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT NULL -- Optional expiry (most are permanent)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_behavior_constraints_tenant_id ON behavior_constraints(tenant_id);
CREATE INDEX IF NOT EXISTS idx_behavior_constraints_user_id ON behavior_constraints(user_id);
CREATE INDEX IF NOT EXISTS idx_behavior_constraints_type ON behavior_constraints(constraint_type);
CREATE INDEX IF NOT EXISTS idx_behavior_constraints_key ON behavior_constraints(constraint_key);
CREATE INDEX IF NOT EXISTS idx_behavior_constraints_active ON behavior_constraints(active) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_behavior_constraints_tenant_user ON behavior_constraints(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_behavior_constraints_correction_id ON behavior_constraints(feedback_correction_id);

-- ===========================================================================
-- VTID-01121: User Trust Score Table
-- ===========================================================================
-- Tracks the current trust score for each user.
-- Trust score is calculated based on correction history and repair actions.

CREATE TABLE IF NOT EXISTS user_trust_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL UNIQUE, -- One trust score per user

    -- Current trust score
    trust_score INT NOT NULL DEFAULT 100 CHECK (trust_score >= 0 AND trust_score <= 100),

    -- Trust components
    correction_count INT NOT NULL DEFAULT 0,
    repair_count INT NOT NULL DEFAULT 0,
    repeated_error_count INT NOT NULL DEFAULT 0,

    -- Trend tracking
    trust_trend TEXT NOT NULL DEFAULT 'stable' CHECK (trust_trend IN ('improving', 'stable', 'declining')),
    last_correction_at TIMESTAMPTZ DEFAULT NULL,
    last_repair_at TIMESTAMPTZ DEFAULT NULL,

    -- Statistics
    total_corrections INT NOT NULL DEFAULT 0,
    total_repairs INT NOT NULL DEFAULT 0,
    active_constraints INT NOT NULL DEFAULT 0,

    -- Audit
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_user_trust_scores_tenant_id ON user_trust_scores(tenant_id);
CREATE INDEX IF NOT EXISTS idx_user_trust_scores_user_id ON user_trust_scores(user_id);
CREATE INDEX IF NOT EXISTS idx_user_trust_scores_score ON user_trust_scores(trust_score);
CREATE INDEX IF NOT EXISTS idx_user_trust_scores_trend ON user_trust_scores(trust_trend);

-- Create unique constraint for user_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_trust_scores_unique_user ON user_trust_scores(user_id);

-- ===========================================================================
-- Enable Row Level Security
-- ===========================================================================

ALTER TABLE feedback_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_repair_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE behavior_constraints ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_trust_scores ENABLE ROW LEVEL SECURITY;

-- ===========================================================================
-- RLS Policies: feedback_corrections
-- ===========================================================================

CREATE POLICY feedback_corrections_select_own ON feedback_corrections
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY feedback_corrections_insert_own ON feedback_corrections
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY feedback_corrections_service_all ON feedback_corrections
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- ===========================================================================
-- RLS Policies: trust_repair_log
-- ===========================================================================

CREATE POLICY trust_repair_log_select_own ON trust_repair_log
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY trust_repair_log_service_all ON trust_repair_log
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- ===========================================================================
-- RLS Policies: behavior_constraints
-- ===========================================================================

CREATE POLICY behavior_constraints_select_own ON behavior_constraints
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY behavior_constraints_insert_own ON behavior_constraints
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY behavior_constraints_update_own ON behavior_constraints
    FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY behavior_constraints_service_all ON behavior_constraints
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- ===========================================================================
-- RLS Policies: user_trust_scores
-- ===========================================================================

CREATE POLICY user_trust_scores_select_own ON user_trust_scores
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY user_trust_scores_service_all ON user_trust_scores
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- ===========================================================================
-- Grant Permissions
-- ===========================================================================

GRANT SELECT, INSERT ON feedback_corrections TO authenticated;
GRANT SELECT ON trust_repair_log TO authenticated;
GRANT SELECT, INSERT, UPDATE ON behavior_constraints TO authenticated;
GRANT SELECT ON user_trust_scores TO authenticated;
GRANT ALL ON feedback_corrections TO service_role;
GRANT ALL ON trust_repair_log TO service_role;
GRANT ALL ON behavior_constraints TO service_role;
GRANT ALL ON user_trust_scores TO service_role;

-- ===========================================================================
-- Comments
-- ===========================================================================

COMMENT ON TABLE feedback_corrections IS 'VTID-01121: User feedback and corrections. All feedback is first-class input and authoritative.';
COMMENT ON COLUMN feedback_corrections.feedback_type IS 'Type of feedback: explicit_correction, preference_clarification, boundary_enforcement, tone_adjustment, suggestion_rejection, autonomy_refusal';
COMMENT ON COLUMN feedback_corrections.correction_target IS 'What was corrected: memory, preference, behavior, recommendation';
COMMENT ON COLUMN feedback_corrections.trust_impact_score IS 'Impact on trust score. Negative = trust decrease, Positive = trust recovery';
COMMENT ON COLUMN feedback_corrections.safety_escalation IS 'TRUE if correction involves medical/emotional content requiring escalation';
COMMENT ON COLUMN feedback_corrections.propagated IS 'TRUE if correction has been propagated to all downstream layers';

COMMENT ON TABLE trust_repair_log IS 'VTID-01121: Trust repair actions and recovery tracking. Trust is repaired through acknowledgment, behavior change, and consistency.';
COMMENT ON COLUMN trust_repair_log.repair_action IS 'Type of repair action: acknowledged, correction_applied, behavior_changed, trust_recovering, trust_restored, repeated_error, constraint_added, rule_updated';
COMMENT ON COLUMN trust_repair_log.trust_delta IS 'Change in trust score (generated column: trust_score_after - trust_score_before)';

COMMENT ON TABLE behavior_constraints IS 'VTID-01121: Rejected behaviors that may not resurface automatically. Permanent unless explicitly removed.';
COMMENT ON COLUMN behavior_constraints.constraint_type IS 'Type of constraint: never_suggest, always_ask_first, confidence_cap, require_confirmation, topic_block, behavior_block, preference_override';
COMMENT ON COLUMN behavior_constraints.active IS 'Whether the constraint is currently active';

COMMENT ON TABLE user_trust_scores IS 'VTID-01121: Current trust score per user. Trust is calculated based on correction history and repair actions.';
COMMENT ON COLUMN user_trust_scores.trust_score IS 'Current trust score (0-100). Starts at 100, decreases with corrections, recovers with repairs.';
COMMENT ON COLUMN user_trust_scores.trust_trend IS 'Current trend: improving, stable, or declining';
