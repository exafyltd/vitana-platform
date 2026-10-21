-- B0d.3 (orb-live-refactor) — orb_wake_timelines table.
--
-- VTID-02917. The first ORB voice reliability timeline storage.
-- Per the plan's measure-before-optimize discipline: this slice EMITS
-- + RENDERS only — no timeout tuning, no reconnect backoff changes,
-- no greeting-latency thresholds. The point is to make the failure
-- visible BEFORE the next "fix" hides it under a nicer first sentence.
--
-- One row per ORB session keyed by session_id. The `events` JSONB
-- array carries the 16 locked event types (wake_clicked,
-- client_context_received, ws_opened, session_start_received,
-- session_context_built, continuation_decision_started/finished,
-- wake_brief_selected, upstream_live_connect_started/connected,
-- first_model_output, first_audio_output, disconnect,
-- reconnect_attempt, reconnect_success, manual_restart_required).
--
-- `aggregates` JSONB carries per-wake + per-disconnect summaries
-- (time_to_first_audio_ms, selected_continuation_kind /
-- none_with_reason, fallback_used, disconnect_reason,
-- session_age_ms, transport, upstream_state). The aggregator builds
-- these on session-end so the read API doesn't have to recompute
-- on every render.
--
-- RLS: tenant-scoped read/write — only the session's tenant can see
-- its rows; service role bypasses RLS.

CREATE TABLE IF NOT EXISTS orb_wake_timelines (
  session_id     TEXT PRIMARY KEY,                  -- not UUID: live-session ids are strings
  tenant_id      UUID,
  user_id        UUID,
  surface        TEXT NOT NULL DEFAULT 'orb_wake',
  events         JSONB NOT NULL DEFAULT '[]'::JSONB,
  aggregates     JSONB,
  transport      TEXT,                              -- 'websocket' | 'sse' | 'rest_stream' | NULL
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at       TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Recent-wakes-per-user lookup is the most common access pattern.
CREATE INDEX IF NOT EXISTS orb_wake_timelines_user_started_idx
  ON orb_wake_timelines (tenant_id, user_id, started_at DESC);

-- For operator queries scoping by time window only.
CREATE INDEX IF NOT EXISTS orb_wake_timelines_started_idx
  ON orb_wake_timelines (started_at DESC);

-- Auto-update `updated_at` on row mutation.
CREATE OR REPLACE FUNCTION orb_wake_timelines_touch_updated_at()
  RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orb_wake_timelines_updated_at_trigger ON orb_wake_timelines;
CREATE TRIGGER orb_wake_timelines_updated_at_trigger
  BEFORE UPDATE ON orb_wake_timelines
  FOR EACH ROW
  EXECUTE FUNCTION orb_wake_timelines_touch_updated_at();

-- Row-level security: tenant isolation. Service role bypasses RLS.
ALTER TABLE orb_wake_timelines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS orb_wake_timelines_tenant_isolation ON orb_wake_timelines;
CREATE POLICY orb_wake_timelines_tenant_isolation
  ON orb_wake_timelines
  FOR ALL
  TO authenticated
  USING (
    tenant_id IS NULL OR tenant_id IN (
      SELECT tenant_id FROM user_tenants WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    tenant_id IS NULL OR tenant_id IN (
      SELECT tenant_id FROM user_tenants WHERE user_id = auth.uid()
    )
  );

COMMENT ON TABLE orb_wake_timelines IS
  'B0d.3 (orb-live-refactor): wake-to-first-audio reliability timeline. '
  'One row per ORB session; events JSONB carries 16 locked event types; '
  'aggregates JSONB carries per-wake + per-disconnect summaries. '
  'Measure-before-optimize discipline: emit + render only in B0d.3, '
  'no timeout/reconnect/greeting-latency tuning before a week of data.';
