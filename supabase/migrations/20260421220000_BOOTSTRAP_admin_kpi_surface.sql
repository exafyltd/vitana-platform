-- BOOTSTRAP-ADMIN-KPI-AA: Unified KPI surface for the admin companion.
--
-- First layer (L1) of the 5-layer admin companion architecture documented
-- in /home/dstev/.claude/plans/atomic-riding-badger.md Part B. Every scanner,
-- insight, voice tool, and autopilot action above it reads from these tables.
--
-- Design:
--   - tenant_kpi_current: real-time snapshot (one row per tenant, upserted)
--   - tenant_kpi_daily: 90-day history (one row per tenant × date)
--   - Both store KPIs as JSONB so the schema can grow (3 families in Phase AA,
--     9 total in Phase BB) without requiring new migrations per family.
--
-- KPI families captured in Phase AA (≈ 20 KPIs): users, community, autopilot.
-- Follow-up phases extend the jsonb payload — readers treat missing fields
-- as null.
--
-- Retention: tenant_kpi_daily keeps 90 days (pg_cron job below). Current
-- is always the latest — upsert replaces.

\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS public.tenant_kpi_current (
  tenant_id UUID PRIMARY KEY,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  kpi JSONB NOT NULL DEFAULT '{}'::jsonb,
  computation_duration_ms INTEGER,
  source_version TEXT
);

COMMENT ON TABLE public.tenant_kpi_current IS
  'BOOTSTRAP-ADMIN-KPI-AA: real-time KPI snapshot per tenant (refreshed every 5 min by admin-awareness-worker).';

CREATE TABLE IF NOT EXISTS public.tenant_kpi_daily (
  tenant_id UUID NOT NULL,
  snapshot_date DATE NOT NULL,
  kpi JSONB NOT NULL DEFAULT '{}'::jsonb,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  computation_duration_ms INTEGER,
  source_version TEXT,
  PRIMARY KEY (tenant_id, snapshot_date)
);

COMMENT ON TABLE public.tenant_kpi_daily IS
  'BOOTSTRAP-ADMIN-KPI-AA: historical daily KPI snapshots per tenant (90-day retention).';

CREATE INDEX IF NOT EXISTS tenant_kpi_daily_tenant_date_desc_idx
  ON public.tenant_kpi_daily (tenant_id, snapshot_date DESC);

-- RLS: tenant admins can read their own tenant's KPIs. Service role writes.
ALTER TABLE public.tenant_kpi_current ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_kpi_daily   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_kpi_current_self_read ON public.tenant_kpi_current;
CREATE POLICY tenant_kpi_current_self_read ON public.tenant_kpi_current
  FOR SELECT TO authenticated
  USING (
    tenant_id IN (
      SELECT ut.tenant_id FROM public.user_tenants ut
      WHERE ut.user_id = auth.uid() AND ut.active_role IN ('admin', 'developer', 'infra')
    )
  );

DROP POLICY IF EXISTS tenant_kpi_daily_self_read ON public.tenant_kpi_daily;
CREATE POLICY tenant_kpi_daily_self_read ON public.tenant_kpi_daily
  FOR SELECT TO authenticated
  USING (
    tenant_id IN (
      SELECT ut.tenant_id FROM public.user_tenants ut
      WHERE ut.user_id = auth.uid() AND ut.active_role IN ('admin', 'developer', 'infra')
    )
  );

DROP POLICY IF EXISTS tenant_kpi_current_service ON public.tenant_kpi_current;
CREATE POLICY tenant_kpi_current_service ON public.tenant_kpi_current
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS tenant_kpi_daily_service ON public.tenant_kpi_daily;
CREATE POLICY tenant_kpi_daily_service ON public.tenant_kpi_daily
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- 90-day retention (best-effort; silently skips if pg_cron missing)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'tenant-kpi-daily-retention',
      '17 3 * * *',
      $$DELETE FROM public.tenant_kpi_daily WHERE snapshot_date < (NOW() - INTERVAL '90 days')::date;$$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron scheduling skipped: %', SQLERRM;
END$$;
