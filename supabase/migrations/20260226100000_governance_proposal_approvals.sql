-- 20260226100000_governance_proposal_approvals.sql
-- Governance Proposal Approval Mechanism
-- Adds approval workflow to governance proposals lifecycle:
-- Draft → Under Review → (approvals collected) → Approved/Rejected → Implemented

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- 1. Add approval_config JSONB column to governance_proposals
-- =============================================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'governance_proposals' AND column_name = 'approval_config'
    ) THEN
        ALTER TABLE governance_proposals
            ADD COLUMN approval_config JSONB NOT NULL DEFAULT '{"required_approvers": 1, "min_review_hours": 24}'::jsonb;
    END IF;
END $$;

-- =============================================================================
-- 2. Create governance_proposal_approvals table
-- =============================================================================
CREATE TABLE IF NOT EXISTS governance_proposal_approvals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    proposal_id UUID NOT NULL REFERENCES governance_proposals(id) ON DELETE CASCADE,
    approver_id TEXT NOT NULL,
    approver_email TEXT,
    decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject', 'request_changes')),
    comment TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(proposal_id, approver_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_proposal_approvals_proposal ON governance_proposal_approvals(proposal_id);
CREATE INDEX IF NOT EXISTS idx_proposal_approvals_approver ON governance_proposal_approvals(approver_id);
CREATE INDEX IF NOT EXISTS idx_proposal_approvals_decision ON governance_proposal_approvals(decision);

-- =============================================================================
-- 3. RLS Policies
-- =============================================================================
ALTER TABLE governance_proposal_approvals ENABLE ROW LEVEL SECURITY;

-- Allow read access to authenticated users
DROP POLICY IF EXISTS "Enable read access for auth users on proposal_approvals" ON governance_proposal_approvals;
CREATE POLICY "Enable read access for auth users on proposal_approvals"
    ON governance_proposal_approvals
    FOR SELECT
    TO authenticated
    USING (true);

-- Allow write access ONLY to service_role (backend)
DROP POLICY IF EXISTS "Enable write access for service role on proposal_approvals" ON governance_proposal_approvals;
CREATE POLICY "Enable write access for service role on proposal_approvals"
    ON governance_proposal_approvals
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- =============================================================================
-- 4. Approval validation function
-- =============================================================================
CREATE OR REPLACE FUNCTION governance_check_proposal_approval(p_proposal_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_proposal RECORD;
    v_config JSONB;
    v_required_approvers INT;
    v_min_review_hours INT;
    v_approvals_count INT;
    v_hours_in_review FLOAT;
    v_review_started_at TIMESTAMPTZ;
    v_errors TEXT[] := '{}';
    v_can_approve BOOLEAN := TRUE;
BEGIN
    -- Fetch the proposal
    SELECT * INTO v_proposal
    FROM governance_proposals
    WHERE id = p_proposal_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'ok', false,
            'can_approve', false,
            'approvals_count', 0,
            'required', 0,
            'hours_in_review', 0,
            'min_hours', 0,
            'errors', jsonb_build_array('Proposal not found')
        );
    END IF;

    -- Parse approval config
    v_config := COALESCE(v_proposal.approval_config, '{"required_approvers": 1, "min_review_hours": 24}'::jsonb);
    v_required_approvers := COALESCE((v_config->>'required_approvers')::INT, 1);
    v_min_review_hours := COALESCE((v_config->>'min_review_hours')::INT, 24);

    -- Count current approvals (only 'approve' decisions count)
    SELECT COUNT(*) INTO v_approvals_count
    FROM governance_proposal_approvals
    WHERE proposal_id = p_proposal_id
      AND decision = 'approve';

    -- Determine when proposal entered 'Under Review' status
    -- Look through timeline for the status change event
    SELECT (elem->>'timestamp')::TIMESTAMPTZ INTO v_review_started_at
    FROM jsonb_array_elements(COALESCE(v_proposal.timeline, '[]'::jsonb)) AS elem
    WHERE elem->>'event' LIKE '%Under Review%'
    ORDER BY (elem->>'timestamp')::TIMESTAMPTZ DESC
    LIMIT 1;

    -- If no timeline entry found, fall back to updated_at
    IF v_review_started_at IS NULL THEN
        v_review_started_at := v_proposal.updated_at;
    END IF;

    -- Calculate hours in review
    v_hours_in_review := EXTRACT(EPOCH FROM (NOW() - v_review_started_at)) / 3600.0;

    -- Check if proposal is in the correct status
    IF v_proposal.status != 'Under Review' THEN
        v_errors := array_append(v_errors, 'Proposal is not in Under Review status (current: ' || v_proposal.status || ')');
        v_can_approve := FALSE;
    END IF;

    -- Check minimum review hours
    IF v_hours_in_review < v_min_review_hours THEN
        v_errors := array_append(v_errors,
            'Minimum review period not met: ' || ROUND(v_hours_in_review::numeric, 1) ||
            ' hours elapsed, ' || v_min_review_hours || ' required');
        v_can_approve := FALSE;
    END IF;

    -- Check if enough approvals
    IF v_approvals_count < v_required_approvers THEN
        v_errors := array_append(v_errors,
            'Insufficient approvals: ' || v_approvals_count ||
            ' of ' || v_required_approvers || ' required');
    END IF;

    RETURN jsonb_build_object(
        'ok', (v_can_approve AND v_approvals_count >= v_required_approvers),
        'can_approve', v_can_approve,
        'approvals_count', v_approvals_count,
        'required', v_required_approvers,
        'hours_in_review', ROUND(v_hours_in_review::numeric, 2),
        'min_hours', v_min_review_hours,
        'errors', to_jsonb(v_errors)
    );
END;
$$;
