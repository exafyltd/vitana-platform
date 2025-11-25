-- 20251125000002_add_oasis_pr_entity_model.sql
-- DEV-CICDL-0207 – Autonomous Safe Merge Layer (Phase 1)
--
-- Creates OASIS PR entity model for tracking PR lifecycle events.
-- This enables deterministic tracking of PR state for autonomous merging.

-- 1) Create PR entities table
CREATE TABLE IF NOT EXISTS oasis_pr_entities (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id TEXT NOT NULL DEFAULT 'SYSTEM',
    pr_number INTEGER NOT NULL,
    repo TEXT NOT NULL DEFAULT 'exafyltd/vitana-platform',
    branch TEXT NOT NULL,
    base_branch TEXT NOT NULL DEFAULT 'main',
    module TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT,
    vtid TEXT,
    ci_status TEXT NOT NULL DEFAULT 'pending' CHECK (ci_status IN ('pending', 'success', 'failed')),
    validator_status TEXT NOT NULL DEFAULT 'pending' CHECK (validator_status IN ('pending', 'success', 'failed')),
    merge_eligible BOOLEAN NOT NULL DEFAULT FALSE,
    merged BOOLEAN NOT NULL DEFAULT FALSE,
    override_flag BOOLEAN NOT NULL DEFAULT FALSE,
    oasis_tracking BOOLEAN NOT NULL DEFAULT FALSE,
    blocked_reason TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create unique constraint on repo + pr_number
CREATE UNIQUE INDEX IF NOT EXISTS idx_oasis_pr_entities_repo_pr
ON oasis_pr_entities(repo, pr_number);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_oasis_pr_entities_tenant ON oasis_pr_entities(tenant_id);
CREATE INDEX IF NOT EXISTS idx_oasis_pr_entities_module ON oasis_pr_entities(module);
CREATE INDEX IF NOT EXISTS idx_oasis_pr_entities_ci_status ON oasis_pr_entities(ci_status);
CREATE INDEX IF NOT EXISTS idx_oasis_pr_entities_validator ON oasis_pr_entities(validator_status);
CREATE INDEX IF NOT EXISTS idx_oasis_pr_entities_merge_eligible ON oasis_pr_entities(merge_eligible);
CREATE INDEX IF NOT EXISTS idx_oasis_pr_entities_vtid ON oasis_pr_entities(vtid);

-- 2) Create PR events table for detailed event tracking
CREATE TABLE IF NOT EXISTS oasis_pr_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id TEXT NOT NULL DEFAULT 'SYSTEM',
    pr_entity_id UUID NOT NULL REFERENCES oasis_pr_entities(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK (event_type IN (
        'PR_CREATED',
        'PR_VALIDATED',
        'PR_CI_PASSED',
        'PR_CI_FAILED',
        'PR_READY_TO_MERGE',
        'PR_MERGED',
        'PR_BLOCKED',
        'PR_OVERRIDE_SET',
        'PR_OVERRIDE_CLEARED'
    )),
    status TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'failed', 'info')),
    message TEXT,
    actor TEXT,
    vtid TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oasis_pr_events_entity ON oasis_pr_events(pr_entity_id);
CREATE INDEX IF NOT EXISTS idx_oasis_pr_events_type ON oasis_pr_events(event_type);
CREATE INDEX IF NOT EXISTS idx_oasis_pr_events_tenant ON oasis_pr_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_oasis_pr_events_created ON oasis_pr_events(created_at DESC);

-- 3) Enable RLS
ALTER TABLE oasis_pr_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE oasis_pr_events ENABLE ROW LEVEL SECURITY;

-- 4) RLS Policies for oasis_pr_entities
DROP POLICY IF EXISTS "Enable read access for auth users on pr_entities" ON oasis_pr_entities;
CREATE POLICY "Enable read access for auth users on pr_entities"
ON oasis_pr_entities FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Enable write access for service role on pr_entities" ON oasis_pr_entities;
CREATE POLICY "Enable write access for service role on pr_entities"
ON oasis_pr_entities FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 5) RLS Policies for oasis_pr_events
DROP POLICY IF EXISTS "Enable read access for auth users on pr_events" ON oasis_pr_events;
CREATE POLICY "Enable read access for auth users on pr_events"
ON oasis_pr_events FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Enable write access for service role on pr_events" ON oasis_pr_events;
CREATE POLICY "Enable write access for service role on pr_events"
ON oasis_pr_events FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 6) Create trigger for updated_at on pr_entities
CREATE OR REPLACE FUNCTION update_oasis_pr_entities_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_oasis_pr_entities_updated_at ON oasis_pr_entities;
CREATE TRIGGER trigger_update_oasis_pr_entities_updated_at
    BEFORE UPDATE ON oasis_pr_entities
    FOR EACH ROW
    EXECUTE FUNCTION update_oasis_pr_entities_updated_at();

-- 7) Create function to check if PR has all required OASIS events
CREATE OR REPLACE FUNCTION check_pr_oasis_tracking(p_pr_entity_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    has_created BOOLEAN;
    has_validated BOOLEAN;
BEGIN
    -- Check for PR_CREATED event
    SELECT EXISTS(
        SELECT 1 FROM oasis_pr_events
        WHERE pr_entity_id = p_pr_entity_id AND event_type = 'PR_CREATED'
    ) INTO has_created;

    -- Check for PR_VALIDATED event
    SELECT EXISTS(
        SELECT 1 FROM oasis_pr_events
        WHERE pr_entity_id = p_pr_entity_id AND event_type = 'PR_VALIDATED'
    ) INTO has_validated;

    RETURN has_created AND has_validated;
END;
$$ LANGUAGE plpgsql;

-- 8) Create function to update PR entity oasis_tracking flag
CREATE OR REPLACE FUNCTION update_pr_oasis_tracking()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE oasis_pr_entities
    SET oasis_tracking = check_pr_oasis_tracking(NEW.pr_entity_id)
    WHERE id = NEW.pr_entity_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_pr_oasis_tracking ON oasis_pr_events;
CREATE TRIGGER trigger_update_pr_oasis_tracking
    AFTER INSERT ON oasis_pr_events
    FOR EACH ROW
    EXECUTE FUNCTION update_pr_oasis_tracking();

RAISE NOTICE 'OASIS PR entity model created successfully for DEV-CICDL-0207';
