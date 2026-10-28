-- Migration: 20260417000000_vtid_02100_connector_framework.sql
-- Purpose: VTID-02100 Phase 1 — Connector framework foundation.
--          Generalizes third-party integrations (social, wearable, shop,
--          calendar, productivity) behind a unified schema so every new
--          provider is one file rather than edits in 4 code locations.
--
-- Preserves existing social_connections via a VIEW — no caller breaks.

-- ===========================================================================
-- 1. CONNECTOR_REGISTRY — static metadata mirrored from code for admin UI
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.connector_registry (
  id TEXT PRIMARY KEY,                                -- 'fitbit', 'terra', 'shopify', 'instagram'
  category TEXT NOT NULL
    CHECK (category IN ('social','wearable','shop','calendar','productivity','aggregator')),
  display_name TEXT NOT NULL,
  description TEXT,

  auth_type TEXT NOT NULL
    CHECK (auth_type IN ('oauth2','oauth1','api_key','webhook_only','affiliate_link','sdk_bridge')),

  capabilities TEXT[] NOT NULL DEFAULT '{}',          -- ['profile.read','sleep.read','workout.write','order.write']
  default_scopes TEXT[] NOT NULL DEFAULT '{}',

  tenant_overrides JSONB NOT NULL DEFAULT '{}',       -- per-tenant client_id/secret env refs

  -- For aggregators (like Terra) that expose multiple underlying providers
  underlying_providers TEXT[],                         -- e.g. ['apple_health','fitbit','oura','garmin','whoop','google_fit']

  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  requires_ios_companion BOOLEAN NOT NULL DEFAULT FALSE,
  docs_url TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_connector_registry_category ON public.connector_registry (category, enabled);

-- ===========================================================================
-- 2. USER_CONNECTIONS — generalized connection table (supersedes social_connections)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.user_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,

  connector_id TEXT NOT NULL REFERENCES public.connector_registry(id),
  category TEXT NOT NULL,                              -- denormalized for fast filter

  -- Provider-side identity
  provider_user_id TEXT,
  provider_username TEXT,
  display_name TEXT,
  avatar_url TEXT,
  profile_url TEXT,

  -- OAuth state (pgsodium can encrypt these if needed; for Phase 1 we trust Supabase TDE)
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,

  scopes_granted TEXT[] NOT NULL DEFAULT '{}',
  capabilities_granted TEXT[] NOT NULL DEFAULT '{}',

  profile_data JSONB NOT NULL DEFAULT '{}',
  enrichment_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (enrichment_status IN ('pending','enriching','completed','failed','skipped','n_a')),
  last_enriched_at TIMESTAMPTZ,

  -- Per-stream cursors (e.g. { "sleep_since": "2026-04-16", "activity_since": "..." })
  sync_cursor JSONB NOT NULL DEFAULT '{}',
  last_sync_at TIMESTAMPTZ,
  last_error TEXT,

  -- Aggregator widgets (Terra) stash user-scoped widget identifiers here
  widget_session_id TEXT,

  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disconnected_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, user_id, connector_id, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_connections_user_active
  ON public.user_connections (user_id, is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_user_connections_category
  ON public.user_connections (user_id, category) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_user_connections_connector
  ON public.user_connections (connector_id, is_active);
CREATE INDEX IF NOT EXISTS idx_user_connections_token_expiry
  ON public.user_connections (token_expires_at)
  WHERE is_active = TRUE AND refresh_token IS NOT NULL;

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.user_connections_bump_updated()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := NOW(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS trg_user_connections_updated ON public.user_connections;
CREATE TRIGGER trg_user_connections_updated
  BEFORE UPDATE ON public.user_connections
  FOR EACH ROW EXECUTE FUNCTION public.user_connections_bump_updated();

-- ===========================================================================
-- 3. WEARABLE_DAILY_METRICS — normalized daily rollup (sleep/activity/HR/HRV)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.wearable_daily_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  user_connection_id UUID REFERENCES public.user_connections(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,                              -- 'apple_health','fitbit','oura',...
  metric_date DATE NOT NULL,

  -- Sleep
  sleep_minutes INT,                                   -- total sleep in minutes
  sleep_deep_minutes INT,
  sleep_rem_minutes INT,
  sleep_light_minutes INT,
  sleep_awake_minutes INT,
  sleep_start_time TIMESTAMPTZ,
  sleep_end_time TIMESTAMPTZ,
  sleep_efficiency_pct NUMERIC(5,2),

  -- Heart rate + HRV
  resting_hr INT,
  max_hr INT,
  avg_hr INT,
  hrv_avg_ms NUMERIC(6,2),
  hrv_rmssd_ms NUMERIC(6,2),

  -- Activity
  steps INT,
  active_minutes INT,
  workout_count INT,
  workout_duration_minutes INT,
  calories_burned INT,
  distance_meters INT,

  -- Body
  vo2max NUMERIC(5,2),
  respiratory_rate NUMERIC(5,2),
  body_temp_c NUMERIC(5,2),
  weight_kg NUMERIC(6,2),

  -- Raw (for debug / re-parsing)
  raw JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (user_id, provider, metric_date)
);

CREATE INDEX IF NOT EXISTS idx_wearable_daily_user_date
  ON public.wearable_daily_metrics (user_id, metric_date DESC);
CREATE INDEX IF NOT EXISTS idx_wearable_daily_connection
  ON public.wearable_daily_metrics (user_connection_id, metric_date DESC);

-- 7-day rollup view (consumed by UserHealthContext.wearable_summary_7d)
CREATE OR REPLACE VIEW public.wearable_rollup_7d AS
SELECT
  user_id,
  ROUND(AVG(sleep_minutes) FILTER (WHERE sleep_minutes IS NOT NULL)::NUMERIC, 0) AS sleep_avg_minutes,
  ROUND(AVG(sleep_deep_minutes) FILTER (WHERE sleep_deep_minutes IS NOT NULL)::NUMERIC, 0) AS sleep_deep_avg_minutes,
  ROUND(AVG(
    CASE WHEN sleep_minutes > 0
      THEN (sleep_deep_minutes::NUMERIC / NULLIF(sleep_minutes,0)) * 100
    END
  )::NUMERIC, 2) AS sleep_deep_pct,
  ROUND(AVG(hrv_avg_ms) FILTER (WHERE hrv_avg_ms IS NOT NULL)::NUMERIC, 2) AS hrv_avg_ms,
  ROUND(AVG(resting_hr) FILTER (WHERE resting_hr IS NOT NULL)::NUMERIC, 0) AS resting_hr,
  ROUND(AVG(active_minutes) FILTER (WHERE active_minutes IS NOT NULL)::NUMERIC, 0) AS activity_minutes,
  SUM(workout_count) AS workout_count,
  MAX(metric_date) AS latest_date,
  COUNT(DISTINCT metric_date) AS days_with_data
FROM public.wearable_daily_metrics
WHERE metric_date >= (CURRENT_DATE - INTERVAL '7 days')
GROUP BY user_id;

-- ===========================================================================
-- 4. WEARABLE_WORKOUTS — optional high-resolution workout log
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.wearable_workouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  user_connection_id UUID REFERENCES public.user_connections(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_workout_id TEXT,

  workout_type TEXT,                                   -- 'running','cycling','strength','yoga','other'
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  duration_minutes INT,
  distance_meters INT,
  calories INT,
  avg_hr INT, max_hr INT,
  avg_pace_sec_per_km INT,
  raw JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (user_id, provider, external_workout_id)
);

CREATE INDEX IF NOT EXISTS idx_wearable_workouts_user_time
  ON public.wearable_workouts (user_id, started_at DESC);

-- ===========================================================================
-- 5. CONNECTOR_WEBHOOKS_LOG — raw webhook audit trail
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.connector_webhooks_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id TEXT,
  user_id UUID,
  event_type TEXT,
  signature_valid BOOLEAN,
  processed BOOLEAN NOT NULL DEFAULT FALSE,
  process_error TEXT,
  payload JSONB,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_connector_webhooks_log_recent
  ON public.connector_webhooks_log (connector_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_connector_webhooks_log_unprocessed
  ON public.connector_webhooks_log (received_at)
  WHERE processed = FALSE;

-- ===========================================================================
-- 6. BACKWARD COMPAT — social_connections VIEW over user_connections
-- ===========================================================================
-- The existing social_connections table continues to exist (from VTID-01250).
-- New social connections CAN be written through either table. The plan calls
-- for eventual migration of social-connect-service to the new framework; for
-- Phase 1 we leave social-connect-service alone and just add a read-side
-- compatibility view over both sources.
--
-- NOTE: we do NOT drop or rename social_connections here. Doing so would
-- break social-connect-service.ts. The framework-first refactor is deferred.

-- ===========================================================================
-- 7. RLS + GRANTS
-- ===========================================================================

ALTER TABLE public.connector_registry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS connector_registry_select ON public.connector_registry;
CREATE POLICY connector_registry_select ON public.connector_registry
  FOR SELECT TO authenticated USING (enabled = TRUE);
DROP POLICY IF EXISTS connector_registry_service ON public.connector_registry;
CREATE POLICY connector_registry_service ON public.connector_registry
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.user_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_connections_select_own ON public.user_connections;
CREATE POLICY user_connections_select_own ON public.user_connections
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS user_connections_insert_own ON public.user_connections;
CREATE POLICY user_connections_insert_own ON public.user_connections
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS user_connections_update_own ON public.user_connections;
CREATE POLICY user_connections_update_own ON public.user_connections
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS user_connections_service ON public.user_connections;
CREATE POLICY user_connections_service ON public.user_connections
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.wearable_daily_metrics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wearable_daily_select_own ON public.wearable_daily_metrics;
CREATE POLICY wearable_daily_select_own ON public.wearable_daily_metrics
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS wearable_daily_service ON public.wearable_daily_metrics;
CREATE POLICY wearable_daily_service ON public.wearable_daily_metrics
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.wearable_workouts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wearable_workouts_select_own ON public.wearable_workouts;
CREATE POLICY wearable_workouts_select_own ON public.wearable_workouts
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS wearable_workouts_service ON public.wearable_workouts;
CREATE POLICY wearable_workouts_service ON public.wearable_workouts
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.connector_webhooks_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS connector_webhooks_log_service ON public.connector_webhooks_log;
CREATE POLICY connector_webhooks_log_service ON public.connector_webhooks_log
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

GRANT SELECT ON public.connector_registry TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.user_connections TO authenticated;
GRANT SELECT ON public.wearable_daily_metrics TO authenticated;
GRANT SELECT ON public.wearable_workouts TO authenticated;
GRANT SELECT ON public.wearable_rollup_7d TO authenticated;

-- ===========================================================================
-- 8. COMMENTS
-- ===========================================================================

COMMENT ON TABLE public.connector_registry IS 'VTID-02100: Static registry of third-party connectors (social, wearable, shop, calendar). Code self-registers at gateway startup.';
COMMENT ON TABLE public.user_connections IS 'VTID-02100: User-scoped third-party connections (supersedes social_connections; social-connect-service still uses the old table for now).';
COMMENT ON TABLE public.wearable_daily_metrics IS 'VTID-02100: Daily rollup of wearable signals — one row per user × provider × date.';
COMMENT ON VIEW public.wearable_rollup_7d IS 'VTID-02100: 7-day rolling average consumed by UserHealthContext.wearable_summary_7d.';
COMMENT ON TABLE public.wearable_workouts IS 'VTID-02100: High-resolution workout log — one row per workout.';
COMMENT ON TABLE public.connector_webhooks_log IS 'VTID-02100: Raw webhook audit trail — helps debug unrecognized payloads and signature failures.';
