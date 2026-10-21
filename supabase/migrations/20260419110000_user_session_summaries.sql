-- =============================================================================
-- VTID-01933 (Companion Phase F): Conversation continuity / session summaries
-- Date: 2026-04-19
--
-- Stores a short summary of each completed ORB session per user. Brain reads
-- the last 1-3 summaries on the next session so Vitana can naturally
-- reference prior conversations ("last time we talked about your sleep —
-- how did the wind-down ritual go?").
--
-- Phase F MVP: summary is built from the last few transcript turns + topic
-- extraction. Future iteration may use a dedicated LLM call to summarize.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS user_session_summaries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id      text NOT NULL,
  channel         text NOT NULL DEFAULT 'voice'
    CHECK (channel IN ('voice', 'text')),
  summary         text NOT NULL,                     -- short prose, 1-3 sentences
  themes          text[] DEFAULT '{}',               -- topical tags ('sleep', 'business', etc.)
  turn_count      int NOT NULL DEFAULT 0,
  duration_ms     int,
  ended_at        timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, session_id)
);

ALTER TABLE user_session_summaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_session_summaries_self_rw"
  ON user_session_summaries FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_user_session_summaries_user_recent
  ON user_session_summaries (user_id, ended_at DESC);

COMMENT ON TABLE user_session_summaries IS
  'VTID-01933 Companion Phase F — short summary of each ORB session per user. Brain reads last 1-3 to weave continuity into next session.';

COMMIT;
