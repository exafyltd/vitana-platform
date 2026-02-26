-- =============================================================================
-- Fix: Persistent Conversation Messages with Supabase Realtime
-- =============================================================================
--
-- Problem: Chat messages are stored only in-memory (Map<string, Thread>) in the
-- gateway process. Every Cloud Run deploy wipes all history, causing 5-10s empty
-- screens on the frontend because there is no table to query.
--
-- Solution: Create conversation_messages table with:
-- 1. Persistent storage for all user + assistant messages
-- 2. Supabase Realtime enabled (REPLICA IDENTITY FULL) for instant push
-- 3. RLS policies for tenant/user isolation
-- 4. Indexes optimized for the two hot queries:
--    a) Load thread history: WHERE thread_id = ? ORDER BY created_at ASC
--    b) Load channel messages: WHERE channel = ? AND tenant_id = ?
-- =============================================================================

-- =============================================================================
-- 1. TABLE: conversation_messages
-- =============================================================================

CREATE TABLE IF NOT EXISTS conversation_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- THREAD ASSOCIATION
  thread_id UUID NOT NULL,

  -- ISOLATION (required for RLS)
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,

  -- MESSAGE CONTENT
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  channel TEXT NOT NULL DEFAULT 'orb' CHECK (channel IN ('orb', 'operator', 'community', 'tenant')),
  content TEXT NOT NULL,

  -- METADATA (model used, latency, tool calls, context pack ref, etc.)
  metadata JSONB NOT NULL DEFAULT '{}',

  -- TIMESTAMPS
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- 2. INDEXES
-- =============================================================================

-- Hot path: load thread history ordered by time
CREATE INDEX IF NOT EXISTS idx_conv_messages_thread_created
  ON conversation_messages(thread_id, created_at ASC);

-- Hot path: load channel messages for a tenant (community/tenant feeds)
CREATE INDEX IF NOT EXISTS idx_conv_messages_channel_tenant
  ON conversation_messages(channel, tenant_id, created_at DESC);

-- User's recent messages across all threads
CREATE INDEX IF NOT EXISTS idx_conv_messages_user_created
  ON conversation_messages(user_id, created_at DESC);

-- =============================================================================
-- 3. ROW LEVEL SECURITY
-- =============================================================================

ALTER TABLE conversation_messages ENABLE ROW LEVEL SECURITY;

-- Service role bypass (gateway uses service role key)
CREATE POLICY conversation_messages_service_role ON conversation_messages
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Users can read their own messages (anon key + JWT)
CREATE POLICY conversation_messages_user_select ON conversation_messages
  FOR SELECT
  USING (user_id = auth.uid());

-- Users can insert their own messages
CREATE POLICY conversation_messages_user_insert ON conversation_messages
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- =============================================================================
-- 4. REALTIME (enables Supabase Realtime subscriptions)
-- =============================================================================

-- REPLICA IDENTITY FULL is required for Supabase Realtime to send the full row
-- on INSERT/UPDATE/DELETE events (not just the PK)
ALTER TABLE conversation_messages REPLICA IDENTITY FULL;

-- Add table to the supabase_realtime publication
-- (safe to run even if publication doesn't exist yet — Supabase creates it)
DO $$
BEGIN
  -- Check if publication exists
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    -- Add table to existing publication
    ALTER PUBLICATION supabase_realtime ADD TABLE conversation_messages;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN
    -- Table already in publication, ignore
    NULL;
END;
$$;

-- =============================================================================
-- 5. HELPER: Get active thread for a user (for prefetch endpoint)
-- =============================================================================

CREATE OR REPLACE FUNCTION get_active_thread_messages(
  p_thread_id UUID,
  p_limit INT DEFAULT 50
)
RETURNS SETOF conversation_messages
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT *
  FROM conversation_messages
  WHERE thread_id = p_thread_id
  ORDER BY created_at ASC
  LIMIT p_limit;
$$;
