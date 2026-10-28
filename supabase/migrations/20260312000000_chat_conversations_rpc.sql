-- Server-side conversation dedup for chat history performance
-- Replaces client-side dedup (fetching 200 rows → JS filter) with a single
-- efficient SQL query that returns 1 row per peer conversation.

CREATE OR REPLACE FUNCTION get_recent_conversations(
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
  peer_id UUID
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
    CASE WHEN m.sender_id = p_user_id THEN m.receiver_id ELSE m.sender_id END AS peer_id
  FROM chat_messages m
  WHERE m.tenant_id = p_tenant_id
    AND (m.sender_id = p_user_id OR m.receiver_id = p_user_id)
  ORDER BY
    CASE WHEN m.sender_id = p_user_id THEN m.receiver_id ELSE m.sender_id END,
    m.created_at DESC
  LIMIT p_limit;
$$;

-- Grant execute to authenticated users (service_role bypasses RLS anyway)
GRANT EXECUTE ON FUNCTION get_recent_conversations TO authenticated;
GRANT EXECUTE ON FUNCTION get_recent_conversations TO service_role;
