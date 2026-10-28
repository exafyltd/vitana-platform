-- BOOTSTRAP-INTENT-COVER-GEN — add cover_url and generation telemetry to user_intents.
--
-- Backs the e6 Find-a-Match cover-photo flow. Stores either a user-uploaded
-- Supabase Storage URL or a server-generated AI image URL. cover_generated_at
-- powers the per-user rate-limit when re-generating covers.

ALTER TABLE user_intents
  ADD COLUMN IF NOT EXISTS cover_url TEXT NULL,
  ADD COLUMN IF NOT EXISTS cover_generated_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS cover_source TEXT NULL CHECK (cover_source IN (
    'user_upload',
    'ai_generated',
    'fallback_curated',
    NULL
  ));

-- Rate-limit lookup: count generations per requester in the last 24h.
CREATE INDEX IF NOT EXISTS idx_user_intents_requester_cover_generated_at
  ON user_intents (requester_user_id, cover_generated_at)
  WHERE cover_generated_at IS NOT NULL;

COMMENT ON COLUMN user_intents.cover_url IS
  'Landscape cover photo for the Find-a-Match preview card. Uploaded by the user or auto-generated server-side.';
COMMENT ON COLUMN user_intents.cover_generated_at IS
  'Timestamp of the most recent server-side cover generation (used for rate-limiting).';
COMMENT ON COLUMN user_intents.cover_source IS
  'Provenance: user_upload | ai_generated | fallback_curated.';
