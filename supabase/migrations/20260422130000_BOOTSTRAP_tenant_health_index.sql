-- =============================================================================
-- BOOTSTRAP-ADMIN-GG: Tenant Health Index
--
-- Daily composite health score 0-100 per tenant, computed from the KPI snapshot
-- and open admin_insights. Stored once per (tenant, day) so weekly reviews +
-- regression alerts can trend it over time.
--
-- Components (weights):
--   engagement       30%  — signup velocity, delta vs prior week
--   community        25%  — events scheduled, groups, new memberships
--   autopilot        25%  — run success rate, activation flow
--   insight_penalty  20%  — open urgent/action_needed insights subtract
--
-- Score = weighted average with insight penalty applied last.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.tenant_health_index_daily (
  tenant_id      UUID NOT NULL,
  snapshot_date  DATE NOT NULL,
  score          INT NOT NULL CHECK (score >= 0 AND score <= 100),
  components     JSONB NOT NULL DEFAULT '{}'::jsonb,
  computed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_version TEXT,
  PRIMARY KEY (tenant_id, snapshot_date)
);

COMMENT ON TABLE public.tenant_health_index_daily IS
  'BOOTSTRAP-ADMIN-GG: composite tenant health score 0-100 per day. Inputs: tenant_kpi_current + admin_insights. Output consumed by weekly review, regression alerts, admin dashboard.';

CREATE INDEX IF NOT EXISTS tenant_health_index_daily_date_idx
  ON public.tenant_health_index_daily (tenant_id, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS tenant_health_index_daily_computed_at_idx
  ON public.tenant_health_index_daily (computed_at DESC);

-- RLS: service-role only; admin routes read through gateway with tenant filter.
ALTER TABLE public.tenant_health_index_daily ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'tenant_health_index_daily'
      AND policyname = 'service_role_all'
  ) THEN
    CREATE POLICY service_role_all ON public.tenant_health_index_daily
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;
