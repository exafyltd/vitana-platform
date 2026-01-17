-- VTID-01181: Governance Controls v1 - System Arming Panel
-- Creates system_controls and system_control_audit tables for runtime control plane.
-- This enables arming/disarming high-risk capabilities (e.g., VTID allocator) without redeploys.

-- =============================================================================
-- 1. system_controls - Stores current state of each control
-- =============================================================================

CREATE TABLE IF NOT EXISTS system_controls (
    key TEXT PRIMARY KEY,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    scope JSONB NOT NULL DEFAULT '{"environment": "dev-sandbox"}'::jsonb,
    reason TEXT NOT NULL DEFAULT '',
    expires_at TIMESTAMPTZ NULL,
    updated_by TEXT NULL,
    updated_by_role TEXT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for queries by enabled state
CREATE INDEX IF NOT EXISTS idx_system_controls_enabled ON system_controls(enabled);

-- Index for expiry checks
CREATE INDEX IF NOT EXISTS idx_system_controls_expires_at ON system_controls(expires_at) WHERE expires_at IS NOT NULL;

-- =============================================================================
-- 2. system_control_audit - Immutable audit log of all control changes
-- =============================================================================

CREATE TABLE IF NOT EXISTS system_control_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key TEXT NOT NULL,
    from_enabled BOOLEAN NOT NULL,
    to_enabled BOOLEAN NOT NULL,
    reason TEXT NOT NULL,
    expires_at TIMESTAMPTZ NULL,
    scope JSONB NOT NULL,
    updated_by TEXT NULL,
    updated_by_role TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for audit queries by control key
CREATE INDEX IF NOT EXISTS idx_system_control_audit_key ON system_control_audit(key);

-- Index for audit queries by time
CREATE INDEX IF NOT EXISTS idx_system_control_audit_created_at ON system_control_audit(created_at DESC);

-- =============================================================================
-- 3. Row Level Security
-- =============================================================================

ALTER TABLE system_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_control_audit ENABLE ROW LEVEL SECURITY;

-- Service role gets full access (backend only)
DROP POLICY IF EXISTS "service_role_system_controls" ON system_controls;
CREATE POLICY "service_role_system_controls" ON system_controls
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_system_control_audit" ON system_control_audit;
CREATE POLICY "service_role_system_control_audit" ON system_control_audit
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

-- Authenticated users can read (UI reads via Gateway API but this allows direct reads if needed)
DROP POLICY IF EXISTS "authenticated_read_system_controls" ON system_controls;
CREATE POLICY "authenticated_read_system_controls" ON system_controls
    FOR SELECT TO authenticated
    USING (true);

DROP POLICY IF EXISTS "authenticated_read_system_control_audit" ON system_control_audit;
CREATE POLICY "authenticated_read_system_control_audit" ON system_control_audit
    FOR SELECT TO authenticated
    USING (true);

-- =============================================================================
-- 4. Seed data - VTID allocator control (DISARMED by default)
-- =============================================================================

INSERT INTO system_controls (key, enabled, scope, reason, expires_at, updated_by, updated_by_role, updated_at)
VALUES (
    'vtid_allocator_enabled',
    FALSE,
    '{"environment": "dev-sandbox"}'::jsonb,
    'Initial state - VTID allocator disabled by default per VTID-01181 governance requirement',
    NULL,
    'migration',
    'system',
    NOW()
)
ON CONFLICT (key) DO NOTHING;

-- =============================================================================
-- 5. Comments for documentation
-- =============================================================================

COMMENT ON TABLE system_controls IS 'VTID-01181: Runtime system controls for arming/disarming high-risk capabilities without redeploys';
COMMENT ON COLUMN system_controls.key IS 'Unique control identifier (e.g., vtid_allocator_enabled)';
COMMENT ON COLUMN system_controls.enabled IS 'Current state - TRUE=armed/enabled, FALSE=disarmed/disabled';
COMMENT ON COLUMN system_controls.scope IS 'JSON scope for control (e.g., {"environment": "dev-sandbox"})';
COMMENT ON COLUMN system_controls.reason IS 'Reason for current state (required for arming)';
COMMENT ON COLUMN system_controls.expires_at IS 'Auto-disarm timestamp (NULL = no expiry)';
COMMENT ON COLUMN system_controls.updated_by IS 'User ID or email who last changed the control';
COMMENT ON COLUMN system_controls.updated_by_role IS 'Role of user who last changed (e.g., dev_admin, governance_admin)';

COMMENT ON TABLE system_control_audit IS 'VTID-01181: Immutable audit log of all system control changes';
COMMENT ON COLUMN system_control_audit.from_enabled IS 'Previous state before change';
COMMENT ON COLUMN system_control_audit.to_enabled IS 'New state after change';
COMMENT ON COLUMN system_control_audit.reason IS 'Reason provided for the change';
