-- B2 (orb-live-refactor) — conversation continuity tables.
--
-- VTID-02932. Two tables that feed signals 40–45 of the assistant
-- decision context:
--
--   user_open_threads   — durable conversation threads the user
--                         left unfinished. Vitana can later say
--                         "I owe you a follow-up about X" without
--                         re-deriving the topic from scratch.
--   assistant_promises  — concrete things Vitana said it would do
--                         or follow up on. Vitana can later say
--                         "last time I promised to remind you
--                         about magnesium — here it is."
--
-- Wall (B2 lane):
--   Selection is read-only. State advancement (creating threads,
--   marking promises kept/broken) happens through dedicated event
--   paths in a follow-up slice — NOT inside the preview/panel
--   routes. Mirrors the B0e wall pattern.
--
-- RLS: tenant-scoped read/write via user_tenants (same pattern as
-- B0c user_assistant_state and B0e.1 awareness tables).

-- ---------------------------------------------------------------
-- user_open_threads — durable unfinished conversations
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS user_open_threads (
  thread_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL,
  user_id              UUID NOT NULL,
  topic                TEXT NOT NULL,
  summary              TEXT,
  status               TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'resolved', 'abandoned')),
  -- Sessions where the thread first appeared and was last mentioned.
  -- Live-session ids are text (e.g. "live-<uuid>"), not UUIDs.
  session_id_first     TEXT,
  session_id_last      TEXT,
  last_mentioned_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_open_threads_user_idx
  ON user_open_threads (tenant_id, user_id, last_mentioned_at DESC);

CREATE INDEX IF NOT EXISTS user_open_threads_open_idx
  ON user_open_threads (tenant_id, user_id, last_mentioned_at DESC)
  WHERE status = 'open';

CREATE OR REPLACE FUNCTION user_open_threads_touch_updated_at()
  RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS user_open_threads_updated_at_trigger ON user_open_threads;
CREATE TRIGGER user_open_threads_updated_at_trigger
  BEFORE UPDATE ON user_open_threads
  FOR EACH ROW
  EXECUTE FUNCTION user_open_threads_touch_updated_at();

ALTER TABLE user_open_threads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_open_threads_tenant_isolation ON user_open_threads;
CREATE POLICY user_open_threads_tenant_isolation
  ON user_open_threads
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

-- ---------------------------------------------------------------
-- assistant_promises — Vitana's owed follow-ups
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS assistant_promises (
  promise_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL,
  user_id              UUID NOT NULL,
  session_id           TEXT,
  thread_id            UUID REFERENCES user_open_threads(thread_id) ON DELETE SET NULL,
  promise_text         TEXT NOT NULL,
  due_at               TIMESTAMPTZ,
  status               TEXT NOT NULL DEFAULT 'owed'
    CHECK (status IN ('owed', 'kept', 'broken', 'cancelled')),
  -- Tying the promise back to a continuation decision lets the
  -- Continuation Inspector trace promised follow-ups end-to-end.
  decision_id          TEXT,
  kept_at              TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assistant_promises_user_idx
  ON assistant_promises (tenant_id, user_id, created_at DESC);

-- Owed promises are the hot-path query — they drive the continuity
-- nudge "I still owe you X". A partial index keeps it small even
-- when the table grows large.
CREATE INDEX IF NOT EXISTS assistant_promises_owed_idx
  ON assistant_promises (tenant_id, user_id, due_at NULLS LAST)
  WHERE status = 'owed';

CREATE OR REPLACE FUNCTION assistant_promises_touch_updated_at()
  RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS assistant_promises_updated_at_trigger ON assistant_promises;
CREATE TRIGGER assistant_promises_updated_at_trigger
  BEFORE UPDATE ON assistant_promises
  FOR EACH ROW
  EXECUTE FUNCTION assistant_promises_touch_updated_at();

ALTER TABLE assistant_promises ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS assistant_promises_tenant_isolation ON assistant_promises;
CREATE POLICY assistant_promises_tenant_isolation
  ON assistant_promises
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

-- ---------------------------------------------------------------
-- Documentation
-- ---------------------------------------------------------------

COMMENT ON TABLE user_open_threads IS
  'B2 (orb-live-refactor): durable record of unfinished conversation '
  'topics. Selection is read-only — state advancement (open→resolved/'
  'abandoned) happens through dedicated event paths in a follow-up '
  'slice, never inside preview/panel routes.';

COMMENT ON TABLE assistant_promises IS
  'B2 (orb-live-refactor): concrete things Vitana said it would do or '
  'follow up on. status: owed | kept | broken | cancelled. decision_id '
  'links back to the AssistantContinuationDecision that produced the '
  'promise, so the Continuation Inspector can trace follow-ups end-to-end.';
