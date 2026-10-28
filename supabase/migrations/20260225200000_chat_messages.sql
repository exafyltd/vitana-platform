-- =============================================================================
-- Chat Messages — User-to-user direct messaging
-- =============================================================================

-- 1. Chat messages table
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  sender_id UUID NOT NULL,
  receiver_id UUID NOT NULL,
  content TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

-- Users can read messages they sent or received
CREATE POLICY "users_read_own_messages"
  ON chat_messages FOR SELECT
  USING (auth.uid() = sender_id OR auth.uid() = receiver_id);

-- Users can insert messages where they are the sender
CREATE POLICY "users_send_messages"
  ON chat_messages FOR INSERT
  WITH CHECK (auth.uid() = sender_id);

-- Users can mark messages addressed to them as read
CREATE POLICY "users_mark_received_read"
  ON chat_messages FOR UPDATE
  USING (auth.uid() = receiver_id)
  WITH CHECK (auth.uid() = receiver_id);

-- Service-role policy for gateway to insert on behalf of users
CREATE POLICY "service_role_manage_chat"
  ON chat_messages FOR ALL
  USING (true)
  WITH CHECK (true);

-- Index: fetch conversation between two users ordered by time
CREATE INDEX idx_chat_messages_conversation
  ON chat_messages (tenant_id, LEAST(sender_id, receiver_id), GREATEST(sender_id, receiver_id), created_at DESC);

-- Index: unread messages per receiver
CREATE INDEX idx_chat_messages_unread
  ON chat_messages (receiver_id, tenant_id)
  WHERE read_at IS NULL;

-- Index: list recent conversations per user
CREATE INDEX idx_chat_messages_user_recent
  ON chat_messages (tenant_id, sender_id, created_at DESC);

CREATE INDEX idx_chat_messages_user_received
  ON chat_messages (tenant_id, receiver_id, created_at DESC);

-- Enable Supabase Realtime so the frontend gets live updates
ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;
