-- =============================================================================
-- VTID-01945 (Companion Phase H): Proactive presence touch log
-- Date: 2026-04-19
--
-- Every time the proactive companion touches the user via ANY surface
-- (welcome banner, priority card, autopilot badge pulse, morning brief push,
-- etc.) a row lands here. The pacer reads the log to enforce frequency caps
-- — at most one unsolicited touch per channel per day, and cross-channel
-- silence respects any active user_proactive_pause.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS user_proactive_touches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  surface         text NOT NULL
    CHECK (surface IN (
      'welcome_banner',
      'priority_card',
      'autopilot_badge',
      'morning_brief',
      'text_chat_awareness',
      'self_awareness_preview',
      'voice_opener'
    )),
  reason_tag      text,                          -- optional, e.g. 'weakness:mental', 'absence:3d'
  sent_at         timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,                   -- user actively engaged (tapped CTA)
  dismissed_at    timestamptz,                   -- user explicitly dismissed
  metadata        jsonb DEFAULT '{}'::jsonb
);

ALTER TABLE user_proactive_touches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_proactive_touches_self_rw"
  ON user_proactive_touches FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_user_proactive_touches_user_surface_sent
  ON user_proactive_touches (user_id, surface, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_proactive_touches_user_sent
  ON user_proactive_touches (user_id, sent_at DESC);

COMMENT ON TABLE user_proactive_touches IS
  'VTID-01945 Companion Phase H — log of every proactive touch across all surfaces. Pacer reads to enforce frequency caps.';

COMMIT;
