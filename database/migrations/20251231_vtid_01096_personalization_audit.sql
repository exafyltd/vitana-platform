-- Migration: 20251231_vtid_01096_personalization_audit.sql
-- Purpose: VTID-01096 Cross-Domain Personalization v1
-- Date: 2025-12-31
--
-- This migration creates the personalization_audit table for tracking
-- personalization decisions and snapshots for audit/safety purposes.
-- Only non-sensitive summaries are stored (no diary raw text).

-- ===========================================================================
-- VTID-01096: Personalization Audit Table
-- ===========================================================================

CREATE TABLE IF NOT EXISTS personalization_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    endpoint TEXT NOT NULL,
    snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_personalization_audit_tenant_id ON personalization_audit(tenant_id);
CREATE INDEX IF NOT EXISTS idx_personalization_audit_user_id ON personalization_audit(user_id);
CREATE INDEX IF NOT EXISTS idx_personalization_audit_endpoint ON personalization_audit(endpoint);
CREATE INDEX IF NOT EXISTS idx_personalization_audit_created_at ON personalization_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_personalization_audit_tenant_user ON personalization_audit(tenant_id, user_id);

-- Enable Row Level Security
ALTER TABLE personalization_audit ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can only read their own audit entries
CREATE POLICY personalization_audit_select_own ON personalization_audit
    FOR SELECT
    USING (auth.uid() = user_id);

-- RLS Policy: Service role can do everything
CREATE POLICY personalization_audit_service_all ON personalization_audit
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Grant permissions
GRANT SELECT, INSERT ON personalization_audit TO authenticated;
GRANT ALL ON personalization_audit TO service_role;

-- ===========================================================================
-- Comments
-- ===========================================================================

COMMENT ON TABLE personalization_audit IS 'VTID-01096: Audit log for cross-domain personalization decisions. Stores non-sensitive summaries only.';
COMMENT ON COLUMN personalization_audit.endpoint IS 'The API endpoint where personalization was applied (e.g., /api/v1/personalization/snapshot)';
COMMENT ON COLUMN personalization_audit.snapshot IS 'JSON snapshot of personalization state (weaknesses, topics, recommendations) - no raw diary text';
