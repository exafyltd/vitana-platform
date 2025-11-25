-- 20251120000002_init_governance_proposals.sql
-- DEV-GOVBE-0106 – Governance Proposals Table
-- Supports proposal lifecycle: Draft → Under Review → Approved/Rejected → Implemented

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Governance Proposals Table
CREATE TABLE IF NOT EXISTS governance_proposals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK (type IN ('New Rule', 'Change Rule', 'Deprecate Rule')),
    rule_code TEXT,
    status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Under Review', 'Approved', 'Rejected', 'Implemented')),
    created_by TEXT NOT NULL CHECK (created_by IN ('User', 'Gemini', 'Claude', 'System', 'Autopilot')),
    original_rule JSONB,
    proposed_rule JSONB NOT NULL,
    rationale TEXT,
    timeline JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_proposals_tenant ON governance_proposals(tenant_id);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON governance_proposals(status);
CREATE INDEX IF NOT EXISTS idx_proposals_rule_code ON governance_proposals(rule_code);
CREATE INDEX IF NOT EXISTS idx_proposals_created_by ON governance_proposals(created_by);
CREATE INDEX IF NOT EXISTS idx_proposals_created_at ON governance_proposals(created_at DESC);

-- RLS Policies
ALTER TABLE governance_proposals ENABLE ROW LEVEL SECURITY;

-- Allow read access to authenticated users
DROP POLICY IF EXISTS "Enable read access for auth users on proposals" ON governance_proposals;
CREATE POLICY "Enable read access for auth users on proposals" 
    ON governance_proposals 
    FOR SELECT 
    TO authenticated 
    USING (true);

-- Allow write access ONLY to service_role (backend)
DROP POLICY IF EXISTS "Enable write access for service role on proposals" ON governance_proposals;
CREATE POLICY "Enable write access for service role on proposals" 
    ON governance_proposals 
    FOR ALL 
    TO service_role 
    USING (true) 
    WITH CHECK (true);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_governance_proposals_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update updated_at
DROP TRIGGER IF EXISTS trigger_update_governance_proposals_updated_at ON governance_proposals;
CREATE TRIGGER trigger_update_governance_proposals_updated_at
    BEFORE UPDATE ON governance_proposals
    FOR EACH ROW
    EXECUTE FUNCTION update_governance_proposals_updated_at();
