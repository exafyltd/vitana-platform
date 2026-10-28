-- impact-allow-solo-migration — pure-RLS fix, no gateway/worker code change needed
-- =============================================================================
-- Fix infinite recursion in chat_group_members RLS, and rewire dependent
-- policies to use a SECURITY DEFINER helper.
--
-- Root cause:
--   The chat_group_members_read policy from 20260525000000_VTID_03089_chat_groups
--   is self-referential — its USING clause does EXISTS over chat_group_members
--   itself. Postgres applies the same policy when evaluating the inner query,
--   producing "infinite recursion detected in policy for relation
--   chat_group_members". The error surfaces on any read path that touches the
--   table, including the users_read_group_messages SELECT policy on
--   chat_messages (which the v1 client triggers via .insert().select() on a DM,
--   even with group_id IS NULL).
--
-- Fix:
--   1) Add a SECURITY DEFINER function is_chat_group_member(group_id, user_id)
--      that checks membership while bypassing RLS.
--   2) Rewrite the chat_group_members_read, chat_groups_member_read and
--      users_read_group_messages / users_send_group_messages policies to call
--      the helper instead of doing the EXISTS subquery inline.
--   3) Also rewire the storage.objects "Users can view chat attachments"
--      policy (added in v1 migration 20260522000000) to use the helper, so
--      the chat_groups arm there can never re-introduce the recursion.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.is_chat_group_member(
  p_group_id UUID,
  p_user_id  UUID
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.chat_group_members
    WHERE group_id = p_group_id
      AND user_id  = p_user_id
  );
$$;

REVOKE ALL ON FUNCTION public.is_chat_group_member(UUID, UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.is_chat_group_member(UUID, UUID)
  TO authenticated, anon, service_role;

-- chat_group_members: members can see the membership list of their own groups.
DROP POLICY IF EXISTS chat_group_members_read ON public.chat_group_members;
CREATE POLICY chat_group_members_read
  ON public.chat_group_members FOR SELECT
  USING (
    public.is_chat_group_member(chat_group_members.group_id, auth.uid())
  );

-- chat_groups: members can see the group row.
DROP POLICY IF EXISTS chat_groups_member_read ON public.chat_groups;
CREATE POLICY chat_groups_member_read
  ON public.chat_groups FOR SELECT
  USING (
    public.is_chat_group_member(chat_groups.id, auth.uid())
  );

-- chat_messages: read group messages.
DROP POLICY IF EXISTS users_read_group_messages ON public.chat_messages;
CREATE POLICY users_read_group_messages
  ON public.chat_messages FOR SELECT
  USING (
    group_id IS NOT NULL
    AND public.is_chat_group_member(chat_messages.group_id, auth.uid())
  );

-- chat_messages: send group messages.
DROP POLICY IF EXISTS users_send_group_messages ON public.chat_messages;
CREATE POLICY users_send_group_messages
  ON public.chat_messages FOR INSERT
  WITH CHECK (
    group_id IS NOT NULL
    AND auth.uid() = sender_id
    AND public.is_chat_group_member(chat_messages.group_id, auth.uid())
  );

-- storage.objects: rewire the chat_groups arm of the chat-attachments SELECT
-- policy (added in v1 migration 20260522000000) to use the helper. We rebuild
-- the policy in full so it stays correct whether or not the v1 migration has
-- already been applied.
DROP POLICY IF EXISTS "Users can view chat attachments" ON storage.objects;

CREATE POLICY "Users can view chat attachments" ON storage.objects
FOR SELECT USING (
  bucket_id = 'chat-attachments' AND (
    auth.uid()::text = (storage.foldername(name))[1]
    OR
    (
      auth.uid()::text = (storage.foldername(name))[2]
      AND EXISTS (
        SELECT 1 FROM public.chat_messages cm
        WHERE cm.receiver_id = auth.uid()
          AND cm.sender_id::text = (storage.foldername(name))[1]
      )
    )
    OR
    (
      (storage.foldername(name))[2] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      AND public.is_chat_group_member(
        ((storage.foldername(name))[2])::uuid,
        auth.uid()
      )
    )
    OR
    EXISTS (
      SELECT 1 FROM public.thread_participants tp
      WHERE tp.user_id = auth.uid()
        AND tp.thread_id::text = (storage.foldername(name))[2]
        AND tp.is_active = true
    )
    OR
    EXISTS (
      SELECT 1 FROM public.global_thread_participants gtp
      WHERE gtp.user_id = auth.uid()
        AND gtp.thread_id::text = (storage.foldername(name))[2]
        AND gtp.is_active = true
    )
  )
);

COMMENT ON FUNCTION public.is_chat_group_member(UUID, UUID) IS
  'SECURITY DEFINER membership check used by chat_groups / chat_group_members / chat_messages RLS to avoid self-referential recursion in chat_group_members policy.';
