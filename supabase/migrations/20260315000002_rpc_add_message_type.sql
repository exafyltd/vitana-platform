-- =============================================================================
-- Update get_recent_conversations RPC to return message_type + metadata
-- =============================================================================
--
-- The new columns added in 20260315000000 need to be surfaced through the RPC
-- so the gateway /api/v1/chat/conversations endpoint can pass them to the
-- frontend for proper voice_transcript rendering.
-- =============================================================================

-- Must DROP first: CREATE OR REPLACE cannot change RETURNS TABLE signature
DROP FUNCTION IF EXISTS get_recent_conversations(UUID, UUID, INT);

CREATE FUNCTION get_recent_conversations(
  p_user_id UUID,
  p_tenant_id UUID,
  p_limit INT DEFAULT 50
)
RETURNS TABLE (
  id UUID,
  tenant_id UUID,
  sender_id UUID,
  receiver_id UUID,
  content TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  peer_id UUID,
  message_type TEXT,
  metadata JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT DISTINCT ON (
    CASE WHEN m.sender_id = p_user_id THEN m.receiver_id ELSE m.sender_id END
  )
    m.id,
    m.tenant_id,
    m.sender_id,
    m.receiver_id,
    m.content,
    m.read_at,
    m.created_at,
    CASE WHEN m.sender_id = p_user_id THEN m.receiver_id ELSE m.sender_id END AS peer_id,
    m.message_type,
    m.metadata
  FROM chat_messages m
  WHERE m.tenant_id = p_tenant_id
    AND (m.sender_id = p_user_id OR m.receiver_id = p_user_id)
  ORDER BY
    CASE WHEN m.sender_id = p_user_id THEN m.receiver_id ELSE m.sender_id END,
    m.created_at DESC
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION get_recent_conversations TO authenticated;
GRANT EXECUTE ON FUNCTION get_recent_conversations TO service_role;
