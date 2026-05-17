-- =============================================================================
-- VTID-03050: B0c-minimal — foundation tables for proactive continuation
-- =============================================================================
-- Schema-only slice. No code consumes these yet — B0d-1 adds the framework,
-- B0d-2 adds providers, B0e adds the feature-discovery coach. Each follow-up
-- slice reads/writes through these tables, so they need to exist first.
--
-- Three tables:
--
--   1) user_assistant_state — durable per-user signals the assistant tracks.
--      The Continuation Contract uses this for dedupe (last_continuation_at
--      per surface, dedupeKey ledger), repetition suppression, and slow-
--      changing facts (greeting style last used, concepts the user has
--      explicitly mastered). EPHEMERAL state (per-session route, surface)
--      MUST NOT live here — those stay in compiled context only.
--
--   2) system_capabilities — catalogue of platform features the orb can
--      introduce. Each row carries its tenant/integration prerequisites so
--      the Feature Discovery coach can answer "is this capability ready for
--      this user right now?" without code changes per capability.
--
--   3) user_capability_awareness — per-user state for each capability:
--      unknown → introduced → seen → tried → completed → mastered, with a
--      dismiss_count branch. The B0e ranker reads from this to pick ONE
--      capability per session to introduce.
--
-- Hard rules (carried forward to B0d / B0e):
--   - RLS: tenant-scoped read/write only.
--   - Service role has full access (gateway service-role client).
--   - Ephemeral state stays in compiled context, never written to these
--     tables.
--   - Decision-contract renderer reads enum-only views — never raw rows
--     from these tables.
--
-- Seed: the canonical capability list goes in B0e's slice. This migration
-- only ships the structure.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. user_assistant_state
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_assistant_state (
  tenant_id      UUID NOT NULL,
  user_id        UUID NOT NULL,
  signal_name    TEXT NOT NULL,
  value          JSONB NOT NULL,
  count          INT NOT NULL DEFAULT 0,
  confidence     NUMERIC(4,3),
  source         TEXT,
  expires_at     TIMESTAMPTZ,
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, user_id, signal_name),
  CONSTRAINT user_assistant_state_confidence_range CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  )
);

CREATE INDEX IF NOT EXISTS idx_user_assistant_state_user
  ON user_assistant_state (user_id);
CREATE INDEX IF NOT EXISTS idx_user_assistant_state_signal
  ON user_assistant_state (tenant_id, signal_name);
CREATE INDEX IF NOT EXISTS idx_user_assistant_state_expires
  ON user_assistant_state (expires_at)
  WHERE expires_at IS NOT NULL;

COMMENT ON TABLE user_assistant_state IS
  'B0c (VTID-03050): durable per-user signals the orb uses for dedupe + repetition suppression. Ephemeral route/surface state belongs in compiled context, never here.';
COMMENT ON COLUMN user_assistant_state.value IS
  'JSONB shape varies by signal_name. The Continuation Inspector + decision-contract-renderer treat unknown shapes as opaque.';

-- ---------------------------------------------------------------------------
-- 2. system_capabilities
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_capabilities (
  capability_key             TEXT PRIMARY KEY,
  display_name               TEXT NOT NULL,
  description                TEXT NOT NULL,
  required_role              TEXT,
  required_tenant_features   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  required_integrations      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  helpful_for_intents        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  enabled                    BOOLEAN NOT NULL DEFAULT TRUE,
  surfaced_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_system_capabilities_enabled
  ON system_capabilities (enabled) WHERE enabled = TRUE;

COMMENT ON TABLE system_capabilities IS
  'B0c (VTID-03050): catalogue of platform capabilities the orb can introduce. B0e Feature Discovery ranker reads required_role / required_tenant_features / required_integrations to gate offers.';

-- ---------------------------------------------------------------------------
-- 3. user_capability_awareness
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_capability_awareness (
  tenant_id            UUID NOT NULL,
  user_id              UUID NOT NULL,
  capability_key       TEXT NOT NULL REFERENCES system_capabilities(capability_key) ON DELETE CASCADE,
  awareness_state      TEXT NOT NULL DEFAULT 'unknown'
                       CHECK (awareness_state IN
                         ('unknown','introduced','seen','tried','completed','dismissed','mastered')),
  first_introduced_at  TIMESTAMPTZ,
  last_introduced_at   TIMESTAMPTZ,
  first_used_at        TIMESTAMPTZ,
  last_used_at         TIMESTAMPTZ,
  use_count            INT NOT NULL DEFAULT 0,
  dismiss_count        INT NOT NULL DEFAULT 0,
  mastery_confidence   NUMERIC(4,3),
  last_surface         TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, user_id, capability_key),
  CONSTRAINT user_capability_awareness_mastery_range CHECK (
    mastery_confidence IS NULL OR (mastery_confidence >= 0 AND mastery_confidence <= 1)
  )
);

CREATE INDEX IF NOT EXISTS idx_user_capability_awareness_user_state
  ON user_capability_awareness (tenant_id, user_id, awareness_state);
CREATE INDEX IF NOT EXISTS idx_user_capability_awareness_dismiss
  ON user_capability_awareness (tenant_id, user_id, dismiss_count)
  WHERE dismiss_count > 0;

COMMENT ON TABLE user_capability_awareness IS
  'B0c (VTID-03050): per-user awareness ladder for system_capabilities. The B0e ranker excludes mastered/completed and de-weights capabilities with dismiss_count > 1.';

-- ---------------------------------------------------------------------------
-- updated_at trigger (shared across the three tables)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_set_updated_at_b0c()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS user_assistant_state_set_updated_at ON user_assistant_state;
CREATE TRIGGER user_assistant_state_set_updated_at
  BEFORE UPDATE ON user_assistant_state
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at_b0c();

DROP TRIGGER IF EXISTS system_capabilities_set_updated_at ON system_capabilities;
CREATE TRIGGER system_capabilities_set_updated_at
  BEFORE UPDATE ON system_capabilities
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at_b0c();

DROP TRIGGER IF EXISTS user_capability_awareness_set_updated_at ON user_capability_awareness;
CREATE TRIGGER user_capability_awareness_set_updated_at
  BEFORE UPDATE ON user_capability_awareness
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at_b0c();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE user_assistant_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_capability_awareness ENABLE ROW LEVEL SECURITY;

-- service_role has full access (gateway uses service-role client).
CREATE POLICY service_role_full_access_user_assistant_state ON user_assistant_state
  FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY service_role_full_access_system_capabilities ON system_capabilities
  FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY service_role_full_access_user_capability_awareness ON user_capability_awareness
  FOR ALL USING (auth.role() = 'service_role');

-- authenticated users can read their own awareness rows + the capability
-- catalogue. Writes go through the gateway service-role path.
CREATE POLICY authenticated_read_user_assistant_state ON user_assistant_state
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY authenticated_read_system_capabilities ON system_capabilities
  FOR SELECT USING (auth.role() = 'authenticated' AND enabled = TRUE);
CREATE POLICY authenticated_read_user_capability_awareness ON user_capability_awareness
  FOR SELECT USING (auth.uid() = user_id);

GRANT SELECT ON system_capabilities TO authenticated;
GRANT SELECT ON user_assistant_state TO authenticated;
GRANT SELECT ON user_capability_awareness TO authenticated;
GRANT ALL ON user_assistant_state TO service_role;
GRANT ALL ON system_capabilities TO service_role;
GRANT ALL ON user_capability_awareness TO service_role;

COMMIT;
