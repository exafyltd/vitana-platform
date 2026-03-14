-- =============================================================================
-- Extend chat_messages: message_type + metadata columns
-- =============================================================================
--
-- Supports voice transcript bridging: ORB voice turns are written to
-- chat_messages so they appear in the DM chat history with Vitana.
--
-- message_type: 'text' (default, existing DMs), 'voice_transcript' (ORB voice)
-- metadata: JSONB for orb_session_id, turn_index, voice_language, links, etc.
-- =============================================================================

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS message_type TEXT NOT NULL DEFAULT 'text';

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN chat_messages.message_type IS
  'Message kind: text (default DM), voice_transcript (ORB voice turn)';

COMMENT ON COLUMN chat_messages.metadata IS
  'Structured metadata: orb_session_id, turn_index, voice_language, direction, links, etc.';
