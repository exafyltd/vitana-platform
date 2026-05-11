-- B0c (orb-live-refactor) — user_assistant_state table.
--
-- Persists DURABLE assistant state per (tenant, user, signal_name).
-- Per the approved plan (Cross-Cutting Implementation Notes):
--   "Match-journey state in user_assistant_state is durable signals only.
--    Ephemeral surface/route stays in compiled context, NEVER in the
--    long-term state table."
--
-- Examples of durable signals:
--   - `concepts_explained_count` per concept (B3 repetition suppression)
--   - `greeting_style_last_used` (B1 cadence)
--   - `dyk_cards_seen` per card (B0e onboarding)
--   - `last_greeted_at_today` (B1 cadence)
--   - `concept_mastery:vitana_index` (B3 mastery ladder)
--   - `feature_discovery_dismissed:pre_match_whois` (B0e onboarding)
--
-- Forbidden signals (these are ephemeral, never persisted here):
--   - current_route, journey_surface, current_match_id, current_intent_id
--   - any per-session transient state that resets on session-start
--
-- RLS: tenant-scoped read/write — only the session's own tenant can
-- see/mutate its rows.

CREATE TABLE IF NOT EXISTS user_assistant_state (
  tenant_id      UUID NOT NULL,
  user_id        UUID NOT NULL,
  signal_name    TEXT NOT NULL,
  value          JSONB NOT NULL,
  count          INT NOT NULL DEFAULT 0,
  confidence     NUMERIC(4,3),               -- 0.000–1.000
  source         TEXT,                       -- 'envelope', 'inferred', 'manual', etc.
  expires_at     TIMESTAMPTZ,
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, signal_name)
);

-- Index for time-based sweeps (expired rows reaped by a future job).
CREATE INDEX IF NOT EXISTS user_assistant_state_expires_at_idx
  ON user_assistant_state (expires_at)
  WHERE expires_at IS NOT NULL;

-- Index for per-user lookups (most common access pattern).
CREATE INDEX IF NOT EXISTS user_assistant_state_user_idx
  ON user_assistant_state (tenant_id, user_id);

-- Auto-update `updated_at` on row mutation.
CREATE OR REPLACE FUNCTION user_assistant_state_touch_updated_at()
  RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS user_assistant_state_updated_at_trigger ON user_assistant_state;
CREATE TRIGGER user_assistant_state_updated_at_trigger
  BEFORE UPDATE ON user_assistant_state
  FOR EACH ROW
  EXECUTE FUNCTION user_assistant_state_touch_updated_at();

-- Row-level security: tenant isolation.
ALTER TABLE user_assistant_state ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS implicitly. Anon role gets no access.
-- Authenticated users see only their own tenant's rows.
DROP POLICY IF EXISTS user_assistant_state_tenant_isolation ON user_assistant_state;
CREATE POLICY user_assistant_state_tenant_isolation
  ON user_assistant_state
  FOR ALL
  TO authenticated
  USING (
    tenant_id IN (
      SELECT tenant_id FROM user_tenants WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    tenant_id IN (
      SELECT tenant_id FROM user_tenants WHERE user_id = auth.uid()
    )
  );

COMMENT ON TABLE user_assistant_state IS
  'B0c (orb-live-refactor): durable assistant state keyed by (tenant, user, signal_name). '
  'Ephemeral route/surface/match-context state belongs in compiled context, NOT here.';
