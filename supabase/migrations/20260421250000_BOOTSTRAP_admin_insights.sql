-- BOOTSTRAP-ADMIN-BB-CC: admin_insights table — the L3 recommendation layer
-- of the admin companion (see atomic-riding-badger.md Part B-3).
--
-- One row per actionable signal produced by a scanner. Insights carry their
-- own confidence, autonomy level, and recommended_action, mirroring the
-- autopilot_recommendations + self-healing_log schema so the same
-- approve/reject/snooze lifecycle can drive them.
--
-- Dedup: (tenant_id, scanner, natural_key) is unique — scanners upsert
-- the same row when the same signal persists across scans. Closing a row
-- sets status=resolved/dismissed and stops further upserts until the
-- signal clears AND reappears later.

\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS public.admin_insights (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL,
  scanner              TEXT NOT NULL,
  natural_key          TEXT NOT NULL,
  domain               TEXT NOT NULL,
  title                TEXT NOT NULL,
  description          TEXT,
  severity             TEXT NOT NULL CHECK (severity IN ('info','warning','action_needed','urgent')),
  actionable           BOOLEAN NOT NULL DEFAULT FALSE,
  recommended_action   JSONB,
  context              JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence_score     NUMERIC(3,2),
  autonomy_level       TEXT NOT NULL DEFAULT 'observe_only'
                         CHECK (autonomy_level IN ('observe_only','diagnose','spec_and_wait','auto_approve_simple','full_auto')),
  status               TEXT NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open','pending_approval','approved','rejected','executed','snoozed','dismissed','resolved')),
  snoozed_until        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at          TIMESTAMPTZ,
  resolved_by          UUID,
  resolved_via         TEXT,
  CONSTRAINT admin_insights_dedup UNIQUE (tenant_id, scanner, natural_key)
);

COMMENT ON TABLE public.admin_insights IS
  'BOOTSTRAP-ADMIN-BB-CC: L3 recommendation layer of the admin companion. Scanners upsert signals; admins approve/reject via orb or console; autopilot executes auto_approve_simple+ rows within guardrails.';

CREATE INDEX IF NOT EXISTS admin_insights_tenant_open_severity_idx
  ON public.admin_insights (tenant_id, status, severity DESC, created_at DESC)
  WHERE status IN ('open','pending_approval');

CREATE INDEX IF NOT EXISTS admin_insights_scanner_key_idx
  ON public.admin_insights (tenant_id, scanner, natural_key);

CREATE INDEX IF NOT EXISTS admin_insights_snoozed_idx
  ON public.admin_insights (snoozed_until)
  WHERE status = 'snoozed';

-- updated_at auto-touch
CREATE OR REPLACE FUNCTION public.touch_admin_insights_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS admin_insights_touch_updated_at ON public.admin_insights;
CREATE TRIGGER admin_insights_touch_updated_at
  BEFORE UPDATE ON public.admin_insights
  FOR EACH ROW EXECUTE FUNCTION public.touch_admin_insights_updated_at();

-- RLS
ALTER TABLE public.admin_insights ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_insights_self_read ON public.admin_insights;
CREATE POLICY admin_insights_self_read ON public.admin_insights
  FOR SELECT TO authenticated
  USING (
    tenant_id IN (
      SELECT ut.tenant_id FROM public.user_tenants ut
      WHERE ut.user_id = auth.uid() AND ut.active_role IN ('admin','developer','infra')
    )
  );

DROP POLICY IF EXISTS admin_insights_service ON public.admin_insights;
CREATE POLICY admin_insights_service ON public.admin_insights
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
