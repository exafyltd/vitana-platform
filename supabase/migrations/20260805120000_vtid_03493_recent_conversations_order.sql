-- VTID-03493 — get_recent_conversations returned an arbitrary slice of the inbox
--
-- The function name promised "recent", but DISTINCT ON forces the ORDER BY to
-- lead with the distinct key, and nothing re-sorted afterwards. So the query
-- was effectively:
--
--   ORDER BY peer_id            -- a UUID
--   LIMIT p_limit
--
-- Picking N rows ordered by a random UUID is not "the N most recent
-- conversations", it is an arbitrary subset. For a member with 199
-- conversations and the gateway's p_limit of 50, only 7 of their 20
-- most-recently-active chats survived — the other 13 were simply absent from
-- the inbox, which is what users reported as their chat history disappearing.
--
-- Fix: keep the DISTINCT ON pass (it correctly picks the newest message per
-- peer), then order that result set by recency in an outer query before
-- applying the limit. Returned rows are now newest-conversation-first, so the
-- caller no longer depends on its own re-sorting either.

CREATE OR REPLACE FUNCTION public.get_recent_conversations(
  p_user_id uuid,
  p_tenant_id uuid,
  p_limit integer DEFAULT 50
)
RETURNS TABLE(
  id uuid,
  tenant_id uuid,
  sender_id uuid,
  receiver_id uuid,
  content text,
  read_at timestamp with time zone,
  created_at timestamp with time zone,
  peer_id uuid,
  message_type text,
  metadata jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $function$
  SELECT
    latest.id,
    latest.tenant_id,
    latest.sender_id,
    latest.receiver_id,
    latest.content,
    latest.read_at,
    latest.created_at,
    latest.peer_id,
    latest.message_type,
    latest.metadata
  FROM (
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
      -- DM rows only. Group messages live in this same table with
      -- receiver_id NULL and group_id set; without this filter a user's own
      -- most recent group message is admitted (it matches on sender_id), and
      -- `peer_id` for it computes to NULL — an inbox entry that identifies no
      -- DM peer. It was previously buried by the peer_id sort; now that rows
      -- are ordered by recency it can surface at the very top.
      AND m.receiver_id IS NOT NULL
      AND m.group_id IS NULL
    ORDER BY
      CASE WHEN m.sender_id = p_user_id THEN m.receiver_id ELSE m.sender_id END,
      m.created_at DESC
  ) latest
  ORDER BY latest.created_at DESC
  LIMIT p_limit;
$function$;
