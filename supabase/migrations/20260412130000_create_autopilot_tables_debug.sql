-- Debug: create tables one at a time outside transaction to see which fails

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

SELECT 'settings created' AS step;

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

SELECT 'bindings created' AS step;

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

SELECT 'runs created' AS step;

-- Verify
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name LIKE 'tenant_autopilot%'
ORDER BY table_name;
