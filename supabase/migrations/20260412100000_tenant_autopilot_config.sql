-- VTID-AP-ADMIN: Tenant-scoped autopilot configuration
-- tenant_autopilot_settings: per-tenant global config (risk caps, domains, rate limits)
-- tenant_autopilot_bindings: per-tenant activation of specific AP catalog entries
--
-- Depends on: tenants(id), app_users(user_id)
-- Idempotent: safe to rerun (IF NOT EXISTS on all objects).

BEGIN;

-- ── tenant_autopilot_settings ────────────────────────────────────────────────
-- One row per tenant. Controls what the autopilot is allowed to do.

CREATE TABLE IF NOT EXISTS tenant_autopilot_settings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  enabled         BOOLEAN NOT NULL DEFAULT true,

  -- Rate limits
  max_recommendations_per_day   INTEGER NOT NULL DEFAULT 20,
  max_activations_per_day       INTEGER NOT NULL DEFAULT 10,

  -- Domain & risk guardrails
  allowed_domains       TEXT[] NOT NULL DEFAULT ARRAY['health','community','longevity','professional','general']::text[],
  allowed_risk_levels   TEXT[] NOT NULL DEFAULT ARRAY['low','medium']::text[],

  -- Auto-activation: recommendations above this confidence auto-execute
  -- NULL = disabled (all require manual approval)
  auto_activate_threshold  NUMERIC(3,2) CHECK (auto_activate_threshold IS NULL OR (auto_activate_threshold >= 0 AND auto_activate_threshold <= 1)),

  -- Retention
  recommendation_retention_days  INTEGER NOT NULL DEFAULT 30,

  -- Scheduling
  generation_schedule   JSONB NOT NULL DEFAULT '{"cron": "0 2 * * *", "timezone": "UTC"}'::jsonb,

  -- Audit
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   UUID REFERENCES app_users(user_id),

  CONSTRAINT uq_tenant_autopilot_settings UNIQUE (tenant_id)
);

-- ── tenant_autopilot_bindings ────────────────────────────────────────────────
-- Each row enables a specific automation for a tenant, with per-binding overrides.

CREATE TABLE IF NOT EXISTS tenant_autopilot_bindings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  automation_id   TEXT NOT NULL,              -- AP-XXXX or source_type key
  enabled         BOOLEAN NOT NULL DEFAULT true,

  -- Schedule override (NULL = use global)
  schedule        JSONB,

  -- Per-binding guardrails (NULL = inherit from tenant_autopilot_settings)
  guardrails      JSONB,

  -- Which roles can trigger this automation
  role_allowances TEXT[] NOT NULL DEFAULT ARRAY['admin']::text[],

  -- Approval flow
  requires_approval   BOOLEAN NOT NULL DEFAULT true,

  -- Rate limits per binding
  max_runs_per_day          INTEGER,
  max_runs_per_user_per_day INTEGER,

  -- Audit
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   UUID REFERENCES app_users(user_id),

  CONSTRAINT uq_tenant_binding UNIQUE (tenant_id, automation_id)
);

-- ── tenant_autopilot_runs ────────────────────────────────────────────────────
-- Execution log: every time an autopilot action runs for a tenant.

CREATE TABLE IF NOT EXISTS tenant_autopilot_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  binding_id      UUID REFERENCES tenant_autopilot_bindings(id) ON DELETE SET NULL,
  automation_id   TEXT NOT NULL,
  triggered_by    UUID REFERENCES app_users(user_id),
  trigger_type    TEXT NOT NULL DEFAULT 'manual',   -- manual | scheduled | auto_activate | webhook
  status          TEXT NOT NULL DEFAULT 'running',  -- running | completed | failed | cancelled
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  duration_ms     INTEGER,
  result          JSONB,
  error_message   TEXT,

  -- Link to VTID if one was created
  activated_vtid  TEXT
);

-- ── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_ap_settings_tenant ON tenant_autopilot_settings(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ap_bindings_tenant ON tenant_autopilot_bindings(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ap_bindings_automation ON tenant_autopilot_bindings(tenant_id, automation_id);
CREATE INDEX IF NOT EXISTS idx_ap_runs_tenant ON tenant_autopilot_runs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ap_runs_status ON tenant_autopilot_runs(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_ap_runs_started ON tenant_autopilot_runs(tenant_id, started_at DESC);

-- ── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE tenant_autopilot_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_autopilot_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_autopilot_runs ENABLE ROW LEVEL SECURITY;

-- Service role (gateway) gets full access
CREATE POLICY IF NOT EXISTS "service_full_access_settings" ON tenant_autopilot_settings
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "service_full_access_bindings" ON tenant_autopilot_bindings
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "service_full_access_runs" ON tenant_autopilot_runs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Authenticated users: read-only on their own tenant (gateway handles writes via service role)
CREATE POLICY IF NOT EXISTS "tenant_read_settings" ON tenant_autopilot_settings
  FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM user_tenants WHERE user_id = auth.uid()));
CREATE POLICY IF NOT EXISTS "tenant_read_bindings" ON tenant_autopilot_bindings
  FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM user_tenants WHERE user_id = auth.uid()));
CREATE POLICY IF NOT EXISTS "tenant_read_runs" ON tenant_autopilot_runs
  FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM user_tenants WHERE user_id = auth.uid()));

-- ── Updated-at trigger ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_autopilot_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ap_settings_updated ON tenant_autopilot_settings;
CREATE TRIGGER trg_ap_settings_updated
  BEFORE UPDATE ON tenant_autopilot_settings
  FOR EACH ROW EXECUTE FUNCTION update_autopilot_updated_at();

DROP TRIGGER IF EXISTS trg_ap_bindings_updated ON tenant_autopilot_bindings;
CREATE TRIGGER trg_ap_bindings_updated
  BEFORE UPDATE ON tenant_autopilot_bindings
  FOR EACH ROW EXECUTE FUNCTION update_autopilot_updated_at();

COMMIT;
