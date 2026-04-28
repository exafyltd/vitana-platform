-- =============================================================================
-- analytics_celebrate_events — Vitana Index celebration ingestion sink
--
-- High-frequency, low-criticality analytics for the celebrate() funnel
-- (index-lift, tier-up, pillar-threshold, streak, at-risk). Kept off
-- oasis_events because OASIS is for state transitions and decisions, not
-- per-event metrics.
--
-- Used by: POST /api/v1/analytics/celebrate
-- Frontend producer: src/lib/celebrate.ts (vitana-v1)
-- Consumers: engagement dashboards, throttle-rate audits, source attribution.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.analytics_celebrate_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id    UUID,
  kind         TEXT NOT NULL,
  magnitude    NUMERIC,
  source       TEXT,
  throttled    BOOLEAN NOT NULL DEFAULT false,
  meta         JSONB DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.analytics_celebrate_events ADD CONSTRAINT valid_celebrate_kind
  CHECK (kind IN ('index-lift', 'tier-up', 'pillar-threshold', 'streak', 'at-risk'));

-- Time-windowed analytics by user (most queries: "last 7 days, this user")
CREATE INDEX IF NOT EXISTS idx_celebrate_user_recent
  ON public.analytics_celebrate_events (user_id, created_at DESC);

-- Aggregate scans by kind across the population (engagement dashboards)
CREATE INDEX IF NOT EXISTS idx_celebrate_kind_recent
  ON public.analytics_celebrate_events (kind, created_at DESC);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE public.analytics_celebrate_events ENABLE ROW LEVEL SECURITY;

-- Users may read their own events (for the "your engagement" surface).
DROP POLICY IF EXISTS celebrate_select_own ON public.analytics_celebrate_events;
CREATE POLICY celebrate_select_own
  ON public.analytics_celebrate_events FOR SELECT
  USING (user_id = auth.uid());

-- Service role bypasses RLS — gateway writes use SUPABASE_SERVICE_ROLE.
DROP POLICY IF EXISTS celebrate_service_role_all ON public.analytics_celebrate_events;
CREATE POLICY celebrate_service_role_all
  ON public.analytics_celebrate_events FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE public.analytics_celebrate_events IS
  'Vitana Index celebration analytics. One row per fired (or throttled) celebrate() call. Backed by POST /api/v1/analytics/celebrate.';
