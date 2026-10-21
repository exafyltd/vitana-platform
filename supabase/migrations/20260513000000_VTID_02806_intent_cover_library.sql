-- VTID-02806 — User Cover-Photo Library + Universal Image
--
-- Adds two new resolution layers between the existing user_upload and
-- ai_generated paths in the Find-a-Match cover-photo chain:
--   2. user_intent_cover_library — multiple activity-tagged photos per user.
--   3. profiles.universal_intent_cover_url — single fallback image used
--      when no library row matches the intent's category. Typically a
--      portrait of the user; lets them avoid AI-generated covers entirely.
--
-- Resolution chain (top wins):
--   1. user_upload      (kind_payload.cover_url at insert)
--   2. user_library     (this migration)
--   3. user_universal   (this migration)
--   4. ai_generated     (existing, becomes gender-aware via gateway change)
--   5. fallback_curated (existing)

-- 1. Universal image column on profiles -------------------------------------

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS universal_intent_cover_url TEXT NULL;

COMMENT ON COLUMN profiles.universal_intent_cover_url IS
  'Single fallback cover photo used when no entry in user_intent_cover_library matches an intent''s category. Typically a portrait of the user; lets them avoid AI-generated covers.';

-- 2. New library table ------------------------------------------------------

CREATE TABLE IF NOT EXISTS user_intent_cover_library (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category     TEXT NOT NULL,
  cover_url    TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE user_intent_cover_library IS
  'Per-user library of activity-tagged cover photos. The gateway picks one matching the intent''s category at cover-resolution time.';
COMMENT ON COLUMN user_intent_cover_library.category IS
  'Dotted intent category, e.g. sport.tennis or dance.social_partner. Matches user_intents.category exactly (no fuzzy or parent-bucket fallback).';

CREATE INDEX IF NOT EXISTS idx_uicl_user_category
  ON user_intent_cover_library (user_id, category);

ALTER TABLE user_intent_cover_library ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS uicl_self_read   ON user_intent_cover_library;
DROP POLICY IF EXISTS uicl_self_insert ON user_intent_cover_library;
DROP POLICY IF EXISTS uicl_self_update ON user_intent_cover_library;
DROP POLICY IF EXISTS uicl_self_delete ON user_intent_cover_library;

CREATE POLICY uicl_self_read   ON user_intent_cover_library FOR SELECT USING (user_id = auth.uid());
CREATE POLICY uicl_self_insert ON user_intent_cover_library FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY uicl_self_update ON user_intent_cover_library FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY uicl_self_delete ON user_intent_cover_library FOR DELETE USING (user_id = auth.uid());

-- 3. Expand user_intents.cover_source CHECK ---------------------------------
-- Existing values: user_upload | ai_generated | fallback_curated
-- New values:      user_library | user_universal

ALTER TABLE user_intents DROP CONSTRAINT IF EXISTS user_intents_cover_source_check;
ALTER TABLE user_intents ADD CONSTRAINT user_intents_cover_source_check
  CHECK (cover_source IS NULL OR cover_source IN (
    'user_upload',
    'ai_generated',
    'fallback_curated',
    'user_library',
    'user_universal'
  ));
