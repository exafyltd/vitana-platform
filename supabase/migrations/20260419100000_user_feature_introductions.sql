-- =============================================================================
-- VTID-01932 (Companion Phase G): Feature-introduction tracking
-- Date: 2026-04-19
--
-- Records which platform features Vitana has already introduced to each user.
-- Brain reads this to avoid re-explaining features the user already knows about.
-- LLM tool record_feature_introduction writes a row when Vitana explains a feature.
--
-- Examples of feature_key values:
--   life_compass, vitana_index, autopilot, memory_garden, calendar,
--   business_hub, marketplace, journey_90day, dismissal_phrases, voice_chat
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS user_feature_introductions (
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feature_key    text NOT NULL,
  introduced_at  timestamptz NOT NULL DEFAULT now(),
  channel        text NOT NULL DEFAULT 'voice'
    CHECK (channel IN ('voice', 'text', 'system')),
  context        jsonb DEFAULT '{}'::jsonb,
  PRIMARY KEY (user_id, feature_key)
);

ALTER TABLE user_feature_introductions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_feature_introductions_self_rw"
  ON user_feature_introductions FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_user_feature_introductions_user
  ON user_feature_introductions (user_id, introduced_at DESC);

COMMENT ON TABLE user_feature_introductions IS
  'VTID-01932 Companion Phase G — records which platform features Vitana has explained to each user. Brain reads to avoid re-introducing.';

COMMENT ON COLUMN user_feature_introductions.feature_key IS
  'Stable identifier for the feature: life_compass, vitana_index, autopilot, memory_garden, calendar, business_hub, marketplace, journey_90day, etc.';

COMMIT;
