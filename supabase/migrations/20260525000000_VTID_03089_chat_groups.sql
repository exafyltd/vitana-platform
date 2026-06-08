-- =============================================================================
-- VTID-03089: Group chat — chat_groups + chat_group_members + chat_messages.group_id
-- =============================================================================
--
-- Adds many-to-many group chat on top of the existing 1-to-1 chat_messages
-- model. A chat_messages row is either a DM (receiver_id set, group_id null)
-- or a group message (group_id set, receiver_id null) — enforced by a check
-- constraint. The first system group is "🎆 FIRST 100" populated by the
-- community-group-enrollment service.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.chat_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_by UUID,
  is_system BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_groups_tenant
  ON public.chat_groups (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.chat_group_members (
  group_id UUID NOT NULL REFERENCES public.chat_groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin', 'bot')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_read_at TIMESTAMPTZ,
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_group_members_user
  ON public.chat_group_members (user_id);

-- Allow group messages: receiver_id may be null when group_id is set.
ALTER TABLE public.chat_messages ALTER COLUMN receiver_id DROP NOT NULL;

ALTER TABLE public.chat_messages
  ADD COLUMN IF NOT EXISTS group_id UUID NULL REFERENCES public.chat_groups(id) ON DELETE SET NULL;

-- Exactly one of (receiver_id, group_id) must be set.
ALTER TABLE public.chat_messages
  DROP CONSTRAINT IF EXISTS chat_messages_target_xor;
ALTER TABLE public.chat_messages
  ADD CONSTRAINT chat_messages_target_xor CHECK (
    (receiver_id IS NOT NULL AND group_id IS NULL) OR
    (receiver_id IS NULL     AND group_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_chat_messages_group_recent
  ON public.chat_messages (group_id, created_at DESC)
  WHERE group_id IS NOT NULL;

-- =============================================================================
-- RLS
-- =============================================================================

ALTER TABLE public.chat_groups        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_group_members ENABLE ROW LEVEL SECURITY;

-- Members see their group's row.
DROP POLICY IF EXISTS chat_groups_member_read ON public.chat_groups;
CREATE POLICY chat_groups_member_read
  ON public.chat_groups FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.chat_group_members m
      WHERE m.group_id = chat_groups.id
        AND m.user_id = auth.uid()
    )
  );

-- Service role manages groups (gateway).
DROP POLICY IF EXISTS chat_groups_service_role ON public.chat_groups;
CREATE POLICY chat_groups_service_role
  ON public.chat_groups FOR ALL
  USING (true) WITH CHECK (true);

-- Members see the member list of groups they belong to.
DROP POLICY IF EXISTS chat_group_members_read ON public.chat_group_members;
CREATE POLICY chat_group_members_read
  ON public.chat_group_members FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.chat_group_members m2
      WHERE m2.group_id = chat_group_members.group_id
        AND m2.user_id = auth.uid()
    )
  );

-- Service role manages membership.
DROP POLICY IF EXISTS chat_group_members_service_role ON public.chat_group_members;
CREATE POLICY chat_group_members_service_role
  ON public.chat_group_members FOR ALL
  USING (true) WITH CHECK (true);

-- Extend chat_messages RLS for group messages.
-- (The DM policies users_read_own_messages / users_send_messages /
--  service_role_manage_chat from the original migration still apply for DMs.)
DROP POLICY IF EXISTS users_read_group_messages ON public.chat_messages;
CREATE POLICY users_read_group_messages
  ON public.chat_messages FOR SELECT
  USING (
    group_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.chat_group_members m
      WHERE m.group_id = chat_messages.group_id
        AND m.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS users_send_group_messages ON public.chat_messages;
CREATE POLICY users_send_group_messages
  ON public.chat_messages FOR INSERT
  WITH CHECK (
    group_id IS NOT NULL
    AND auth.uid() = sender_id
    AND EXISTS (
      SELECT 1 FROM public.chat_group_members m
      WHERE m.group_id = chat_messages.group_id
        AND m.user_id = auth.uid()
    )
  );

-- =============================================================================
-- Realtime publication
-- =============================================================================

DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_groups;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_group_members;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END$$;

COMMENT ON TABLE  public.chat_groups        IS 'Group chats (e.g. "🎆 FIRST 100"). 1-to-1 DMs continue using chat_messages.receiver_id.';
COMMENT ON TABLE  public.chat_group_members IS 'Group membership and per-user last_read_at for unread counts.';
COMMENT ON COLUMN public.chat_messages.group_id IS 'When set, this message is a group message; receiver_id is NULL. Mutex enforced by chat_messages_target_xor.';
