-- =============================================================================
-- OpenClaw Bridge Tables
-- Supports the Vitana Autopilot OpenClaw integration.
-- =============================================================================

-- Autopilot action logs (audit trail for all OpenClaw operations)
CREATE TABLE IF NOT EXISTS autopilot_logs (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  action      text NOT NULL,
  actor       text NOT NULL DEFAULT 'openclaw-autopilot',
  details     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_autopilot_logs_tenant
  ON autopilot_logs (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_autopilot_logs_action
  ON autopilot_logs (action, created_at DESC);

-- RLS: tenant isolation
ALTER TABLE autopilot_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY autopilot_logs_tenant_isolation ON autopilot_logs
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Service role bypass for the bridge
CREATE POLICY autopilot_logs_service_role ON autopilot_logs
  FOR ALL
  USING (current_setting('role', true) = 'service_role');

-- User consent tracking for health operations
CREATE TABLE IF NOT EXISTS user_consents (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  user_id       uuid NOT NULL,
  purpose       text NOT NULL,
  consent_given boolean NOT NULL DEFAULT false,
  consent_date  timestamptz,
  scope         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, user_id, purpose)
);

CREATE INDEX IF NOT EXISTS idx_user_consents_lookup
  ON user_consents (tenant_id, user_id, purpose);

ALTER TABLE user_consents ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_consents_tenant_isolation ON user_consents
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY user_consents_service_role ON user_consents
  FOR ALL
  USING (current_setting('role', true) = 'service_role');
