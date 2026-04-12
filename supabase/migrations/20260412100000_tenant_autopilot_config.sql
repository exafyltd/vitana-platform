-- VTID-AP-ADMIN: Tenant-scoped autopilot configuration
-- Fixed: replaced CREATE POLICY IF NOT EXISTS (PG15+) with DO $$ blocks for PG14 compat

BEGIN;

-- ── tenant_autopilot_settings ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tenant_autopilot_settings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  max_recommendations_per_day   INTEGER NOT NULL DEFAULT 20,
  max_activations_per_day       INTEGER NOT NULL DEFAULT 10,
  allowed_domains       TEXT[] NOT NULL DEFAULT ARRAY['health','community','longevity','professional','general']::text[],
  allowed_risk_levels   TEXT[] NOT NULL DEFAULT ARRAY['low','medium']::text[],
  auto_activate_threshold  NUMERIC(3,2) CHECK (auto_activate_threshold IS NULL OR (auto_activate_threshold >= 0 AND auto_activate_threshold <= 1)),
  recommendation_retention_days  INTEGER NOT NULL DEFAULT 30,
  generation_schedule   JSONB NOT NULL DEFAULT '{"cron": "0 2 * * *", "timezone": "UTC"}'::jsonb,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   UUID REFERENCES app_users(user_id),
  CONSTRAINT uq_tenant_autopilot_settings UNIQUE (tenant_id)
);

-- ── tenant_autopilot_bindings ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tenant_autopilot_bindings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  automation_id   TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  schedule        JSONB,
  guardrails      JSONB,
  role_allowances TEXT[] NOT NULL DEFAULT ARRAY['admin']::text[],
  requires_approval   BOOLEAN NOT NULL DEFAULT true,
  max_runs_per_day          INTEGER,
  max_runs_per_user_per_day INTEGER,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   UUID REFERENCES app_users(user_id),
  CONSTRAINT uq_tenant_binding UNIQUE (tenant_id, automation_id)
);

-- ── tenant_autopilot_runs ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tenant_autopilot_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  binding_id      UUID REFERENCES tenant_autopilot_bindings(id) ON DELETE SET NULL,
  automation_id   TEXT NOT NULL,
  triggered_by    UUID REFERENCES app_users(user_id),
  trigger_type    TEXT NOT NULL DEFAULT 'manual',
  status          TEXT NOT NULL DEFAULT 'running',
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  duration_ms     INTEGER,
  result          JSONB,
  error_message   TEXT,
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

-- PG14-compatible policy creation (DROP + CREATE instead of IF NOT EXISTS)
DO $$ BEGIN
  DROP POLICY IF EXISTS "service_full_access_settings" ON tenant_autopilot_settings;
  CREATE POLICY "service_full_access_settings" ON tenant_autopilot_settings
    FOR ALL TO service_role USING (true) WITH CHECK (true);
END $$;

DO $$ BEGIN
  DROP POLICY IF EXISTS "service_full_access_bindings" ON tenant_autopilot_bindings;
  CREATE POLICY "service_full_access_bindings" ON tenant_autopilot_bindings
    FOR ALL TO service_role USING (true) WITH CHECK (true);
END $$;

DO $$ BEGIN
  DROP POLICY IF EXISTS "service_full_access_runs" ON tenant_autopilot_runs;
  CREATE POLICY "service_full_access_runs" ON tenant_autopilot_runs
    FOR ALL TO service_role USING (true) WITH CHECK (true);
END $$;

DO $$ BEGIN
  DROP POLICY IF EXISTS "tenant_read_settings" ON tenant_autopilot_settings;
  CREATE POLICY "tenant_read_settings" ON tenant_autopilot_settings
    FOR SELECT TO authenticated
    USING (tenant_id IN (SELECT tenant_id FROM user_tenants WHERE user_id = auth.uid()));
END $$;

DO $$ BEGIN
  DROP POLICY IF EXISTS "tenant_read_bindings" ON tenant_autopilot_bindings;
  CREATE POLICY "tenant_read_bindings" ON tenant_autopilot_bindings
    FOR SELECT TO authenticated
    USING (tenant_id IN (SELECT tenant_id FROM user_tenants WHERE user_id = auth.uid()));
END $$;

DO $$ BEGIN
  DROP POLICY IF EXISTS "tenant_read_runs" ON tenant_autopilot_runs;
  CREATE POLICY "tenant_read_runs" ON tenant_autopilot_runs
    FOR SELECT TO authenticated
    USING (tenant_id IN (SELECT tenant_id FROM user_tenants WHERE user_id = auth.uid()));
END $$;

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
